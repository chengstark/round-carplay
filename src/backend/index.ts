import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { Server, type Socket } from 'socket.io'
import { CarplayService } from '../main/carplay/CarplayService'
import { BluetoothService } from '../main/bluetooth/BluetoothService'
import type { WifiCameraOptions } from '../main/Globals'
import type { ServiceEventSink } from '../main/events/ServiceEventSink'
import { GpsService } from '../main/gps/GpsService'
import { NetworkService } from '../main/network/NetworkService'
import { RuntimeSwitchService, type RuntimeKind } from '../main/runtime/RuntimeSwitchService'
import { SystemUpdateService } from '../main/update/SystemUpdateService'
import { OtaUpdateService } from '../main/update/OtaUpdateService'
import { USBService } from '../main/usb/USBService'
import { WifiCameraService } from '../main/wifi/WifiCameraService'
import { BrowserUpdateService } from './BrowserUpdateService'
import { ConfigStore } from './ConfigStore'

type RpcRequest = { method?: unknown; args?: unknown }
type RpcReply = { ok: true; value: unknown } | { ok: false; error: string }
type RpcAcknowledge = (reply: RpcReply) => void

const HOST = '127.0.0.1'
const PORT = parsePort(process.env.ROUND_CARPLAY_PORT)
const dataDirectory = resolve(
  process.env.ROUND_CARPLAY_DATA_DIR?.trim() || join(homedir(), '.config', 'round-carplay')
)
const uiDirectory = resolve(
  process.env.ROUND_CARPLAY_UI_DIR?.trim() || join(__dirname, '../renderer')
)
const configStore = new ConfigStore(join(dataDirectory, 'config.json'))

let io: Server | null = null
const socketEvents: ServiceEventSink = {
  send(channel, payload) {
    if (!io || io.engine.clientsCount === 0) return false
    // CarPlay frames must be reliable. A resolution event is emitted just
    // before the first frame, and Socket.IO may discard a subsequent volatile
    // packet while that earlier write is still draining. The camera has its
    // own acknowledgement/backpressure path and intentionally remains live-
    // edge/volatile.
    if (channel === 'wifi-camera-frame') {
      io.volatile.emit(channel, payload)
    } else {
      io.emit(channel, payload)
    }
    return true
  }
}

const carplay = new CarplayService(socketEvents, dataDirectory)
const usb = new USBService(carplay, socketEvents)
const wifiCamera = new WifiCameraService(socketEvents)
const gps = new GpsService(undefined, socketEvents)
const network = new NetworkService()
const bluetooth = new BluetoothService()
const power = new SystemUpdateService()
const updater = new BrowserUpdateService()
const otaUpdater = new OtaUpdateService(() => wifiCamera.isActive())
const runtime = new RuntimeSwitchService()

gps.setSmoothing(configStore.get().gpsSmoothing)

const httpServer = createServer((request, response) => serveHttp(request, response))
io = new Server(httpServer, {
  serveClient: false,
  transports: ['websocket'],
  maxHttpBufferSize: 20 * 1024 * 1024,
  allowRequest: (request, callback) => callback(null, isLocalOrigin(request.headers.origin))
})

io.on('connection', (socket) => {
  socket.emit('settings', configStore.get())
  socket.emit('gps-state', gps.getState())
  socket.emit('usb-event', usb.getLastEvent())

  socket.on('getSettings', () => socket.emit('settings', configStore.get()))
  socket.on('saveSettings', (settings) => saveSettings(settings))
  socket.on('rpc', (request: RpcRequest, acknowledge: RpcAcknowledge) => {
    void handleRpc(socket, request)
      .then((value) => acknowledge({ ok: true, value }))
      .catch((error) => {
        console.error('[Backend] RPC failed', request.method, error)
        acknowledge({ ok: false, error: errorMessage(error) })
      })
  })
})

httpServer.listen(PORT, HOST, () => {
  console.log(`[Backend] Browser kiosk ready at http://${HOST}:${PORT}`)
  void gps.start()
})

async function handleRpc(socket: Socket, request: RpcRequest): Promise<unknown> {
  if (typeof request.method !== 'string' || !Array.isArray(request.args)) {
    throw new Error('Invalid RPC request')
  }
  const args = request.args

  switch (request.method) {
    case 'quit':
      return { ok: true }
    case 'settings.get':
      return configStore.get()
    case 'settings.save':
      return saveSettings(args[0])
    case 'usb.forceReset':
      return usb.forceReset()
    case 'usb.detectDongle':
      return usb.detectDongle()
    case 'usb.getDeviceInfo':
      return usb.getDeviceInfo()
    case 'usb.getLastEvent':
      return usb.getLastEvent()
    case 'usb.getSysdefaultPrettyName':
      return usb.getSysdefaultPrettyName()
    case 'wifiCamera.start': {
      const connection = await network.connectCameraWifi()
      if (!connection.ok) {
        console.warn('[Backend] Camera Wi-Fi connection failed', connection.message)
        return { ok: false, error: connection.message }
      }
      return wifiCamera.start(requireCameraOptions(args[0]))
    }
    case 'wifiCamera.configure':
      return wifiCamera.configure(requireCameraOptions(args[0]))
    case 'wifiCamera.stop': {
      wifiCamera.stop()
      return { ok: true, message: 'Camera stopped; camera Wi-Fi kept active for fast reopening' }
    }
    case 'wifiCamera.acknowledgeFrame':
      wifiCamera.acknowledgeFrame()
      return undefined
    case 'gps.getState':
      return gps.getState()
    case 'network.scanWifi':
      return network.scanWifi()
    case 'network.connectWifi':
      return network.connectWifi(requireString(args[0], 'SSID'), requireString(args[1], 'password'))
    case 'network.getIpAddresses':
      return network.getIpAddresses()
    case 'bluetooth.scan':
      return bluetooth.scan()
    case 'bluetooth.connect':
      return bluetooth.connect(requireString(args[0], 'Bluetooth address'))
    case 'bluetooth.disconnect':
      return bluetooth.disconnect(requireString(args[0], 'Bluetooth address'))
    case 'update.getStatus':
      return otaUpdater.isConfigured() ? otaUpdater.getStatus() : updater.getStatus()
    case 'update.start':
      return (otaUpdater.isConfigured() ? otaUpdater : updater).update((status) =>
        socketEvents.send('system-update-status', status)
      )
    case 'update.reboot':
      return power.reboot()
    case 'update.powerOff':
      return power.powerOff()
    case 'runtime.getStatus':
      return runtime.getStatus('browser')
    case 'runtime.switchTo': {
      const target = requireRuntime(args[0])
      if (target !== 'electron') throw new Error('Invalid runtime switch target')
      const result = await runtime.switchTo('browser', target)
      if (!result.ok) return result
      const reboot = await power.reboot()
      return reboot.ok
        ? { ok: true, message: 'Switching to the Electron version…' }
        : { ok: false, message: `${result.message}, but the reboot failed: ${reboot.message}` }
    }
    case 'carplay.start':
      return carplay.start()
    case 'carplay.stop':
      return carplay.stop()
    case 'carplay.sendFrame':
      carplay.sendFrame()
      return undefined
    case 'carplay.sendTouch':
      carplay.sendTouch(requireNumber(args[0]), requireNumber(args[1]), requireNumber(args[2]))
      return undefined
    case 'carplay.sendKeyCommand':
      carplay.sendKeyCommand(requireString(args[0], 'command'))
      return undefined
    default:
      throw new Error('Unknown RPC method')
  }
}

function saveSettings(value: unknown) {
  if (!value || typeof value !== 'object') throw new Error('Invalid settings payload')
  const settings = configStore.save(value as ReturnType<ConfigStore['get']>)
  gps.setSmoothing(settings.gpsSmoothing)
  socketEvents.send('settings', settings)
  return settings
}

function serveHttp(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url || '/', `http://${HOST}:${PORT}`)
  if (url.pathname === '/diagnostics' && request.method === 'POST') {
    receiveBrowserDiagnostic(request, response)
    return
  }
  if (url.pathname === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify({ ok: true, runtime: 'browser' }))
    return
  }
  if (url.pathname.startsWith('/socket.io/')) return

  const requestedPath =
    url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1))
  const candidate = resolve(uiDirectory, normalize(requestedPath))
  const allowed = candidate === uiDirectory || candidate.startsWith(`${uiDirectory}${sep}`)
  const file =
    allowed && existsSync(candidate) && statSync(candidate).isFile()
      ? candidate
      : join(uiDirectory, 'index.html')

  if (!existsSync(file)) {
    response.writeHead(503, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    response.end('<!doctype html><title>Round CarPlay</title><h1>UI bundle is not installed</h1>')
    return
  }

  response.writeHead(200, {
    'Content-Type': mimeType(extname(file)),
    'Cache-Control':
      file.endsWith('index.html') || file.endsWith('audio.worklet.js')
        ? 'no-store'
        : 'public, max-age=31536000, immutable',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff'
  })
  createReadStream(file).pipe(response)
}

function receiveBrowserDiagnostic(request: IncomingMessage, response: ServerResponse): void {
  let body = ''
  request.setEncoding('utf8')
  request.on('data', (chunk: string) => {
    if (body.length <= 16_384) body += chunk
  })
  request.on('end', () => {
    try {
      const diagnostic = JSON.parse(body) as { event?: unknown; detail?: unknown }
      const event = String(diagnostic.event ?? 'unknown').slice(0, 120)
      const detail = JSON.stringify(diagnostic.detail ?? {}).slice(0, 4_000)
      console.log(`[BrowserDiagnostics] ${event} ${detail}`)
    } catch {
      console.warn('[BrowserDiagnostics] Invalid diagnostic payload')
    }
    response.writeHead(204, { 'Cache-Control': 'no-store' })
    response.end()
  })
}

function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true
  try {
    const url = new URL(origin)
    return (
      (url.hostname === HOST || url.hostname === 'localhost') &&
      Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === PORT
    )
  } catch {
    return false
  }
}

function requireCameraOptions(value: unknown): WifiCameraOptions {
  if (!value || typeof value !== 'object') throw new Error('Invalid camera options')
  return value as WifiCameraOptions
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`)
  return value
}

function requireNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid number')
  return value
}

function requireRuntime(value: unknown): RuntimeKind {
  if (value !== 'electron' && value !== 'browser') throw new Error('Invalid runtime')
  return value
}

function parsePort(value: string | undefined): number {
  const port = Number(value || 4000)
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 4000
}

function mimeType(extension: string): string {
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.wasm': 'application/wasm'
    }[extension.toLowerCase()] || 'application/octet-stream'
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function shutdown(signal: string): Promise<void> {
  console.log(`[Backend] ${signal}; shutting down`)
  carplay.prepareForShutdown()
  wifiCamera.stop()
  gps.stop()
  await carplay.stop()
  await usb.stop()
  io?.close()
  httpServer.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 5_000).unref()
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
