import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { Server, type Socket } from 'socket.io'
import type { ServiceEventSink } from '../main/events/ServiceEventSink'
import { NetworkService } from '../main/network/NetworkService'
import { SystemUpdateService } from '../main/update/SystemUpdateService'
import { OtaUpdateService } from '../main/update/OtaUpdateService'
import { BrowserUpdateService } from './BrowserUpdateService'
import { ConfigStore } from './ConfigStore'
import { PlayPortBridge } from './PlayPortBridge'
import { BrightnessService } from '../main/brightness/BrightnessService'
import { SpeedOcrService } from './SpeedOcrService'
import { PiUpdateService } from './PiUpdateService'

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
    // packet while that earlier write is still draining.
    io.emit(channel, payload)
    return true
  }
}

const network = new NetworkService()
const power = new SystemUpdateService()
const updater = new BrowserUpdateService()
const otaUpdater = new OtaUpdateService()
const brightness = new BrightnessService(dataDirectory)
const speedOcr = new SpeedOcrService()
const piUpdater = new PiUpdateService()
const isPiDeployment = process.env.ROUND_CARPLAY_DEPLOYMENT === 'playport-pi'
let brightnessOwner: string | null = null
let brightnessTimer: ReturnType<typeof setTimeout> | null = null

async function releaseBrightness(owner: string, immediate = false): Promise<unknown> {
  if (brightnessOwner !== owner) return brightness.getStatus()
  if (brightnessTimer) clearTimeout(brightnessTimer)
  brightnessTimer = null
  // Queue OFF before another socket can acquire the controller.
  try {
    return await brightness.stop(immediate)
  } finally {
    if (brightnessOwner === owner) brightnessOwner = null
  }
}

const httpServer = createServer((request, response) => serveHttp(request, response))
const playPortBridge = new PlayPortBridge(httpServer, {
  upstreamUrl: process.env.PLAYPORT_WS_URL?.trim(),
  allowSelfSignedCertificate: process.env.PLAYPORT_ALLOW_SELF_SIGNED === '1',
  allowOrigin: isLocalOrigin
})
io = new Server(httpServer, {
  serveClient: false,
  transports: ['websocket'],
  maxHttpBufferSize: 20 * 1024 * 1024,
  allowRequest: (request, callback) => callback(null, isLocalOrigin(request.headers.origin))
})

io.on('connection', (socket) => {
  socket.on('disconnect', () => {
    if (brightnessOwner === socket.id) void releaseBrightness(socket.id, true)
  })
  socket.emit('settings', configStore.get())
  if (isPiDeployment) socket.emit('system-update-status', piUpdater.getStatus())

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
  if (isPiDeployment) piUpdater.startAutomatic(status => socketEvents.send('system-update-status', status))
})

async function handleRpc(socket: Socket, request: RpcRequest): Promise<unknown> {
  if (typeof request.method !== 'string' || !Array.isArray(request.args)) {
    throw new Error('Invalid RPC request')
  }
  const args = request.args

  switch (request.method) {
    case 'brightness.getStatus':
      return brightness.getStatus()
    case 'brightness.start': {
      const direction = args[0]
      if (direction !== 'increase' && direction !== 'decrease') throw new Error('Invalid brightness direction')
      if (brightnessOwner) throw new Error('Brightness adjustment is already active')
      brightnessOwner = socket.id
      brightnessTimer = setTimeout(() => void releaseBrightness(socket.id, true), 12_000)
      const result = await brightness.start(direction)
      if (!result.ok && brightnessOwner === socket.id) await releaseBrightness(socket.id, true)
      return result
    }
    case 'brightness.stop':
      return releaseBrightness(socket.id, args[0] === true)
    case 'quit':
      return { ok: true }
    case 'settings.get':
      return configStore.get()
    case 'settings.save':
      return saveSettings(args[0])
    case 'network.scanWifi':
      return network.scanWifi()
    case 'network.connectWifi':
      return network.connectWifi(requireString(args[0], 'SSID'), requireString(args[1], 'password'))
    case 'network.getIpAddresses':
      return network.getIpAddresses()
    case 'update.getStatus':
      if (isPiDeployment) return piUpdater.getStatus()
      return otaUpdater.isConfigured() ? otaUpdater.getStatus() : updater.getStatus()
    case 'update.start':
      if (isPiDeployment) return piUpdater.update(status => socketEvents.send('system-update-status', status))
      return (otaUpdater.isConfigured() ? otaUpdater : updater).update((status) =>
        socketEvents.send('system-update-status', status)
      )
    case 'update.reboot':
      return power.reboot()
    case 'update.powerOff':
      return power.powerOff()
    default:
      throw new Error('Unknown RPC method')
  }
}

function saveSettings(value: unknown) {
  if (!value || typeof value !== 'object') throw new Error('Invalid settings payload')
  const settings = configStore.save(value as ReturnType<ConfigStore['get']>)
  socketEvents.send('settings', settings)
  return settings
}

function serveHttp(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url || '/', `http://${HOST}:${PORT}`)
  if (url.pathname === '/api/speed-ocr') {
    if (request.method !== 'POST' || !isLocalOrigin(request.headers.origin) || request.headers['content-type'] !== 'image/png') {
      response.writeHead(403).end()
      return
    }
    let length = 0
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      length += chunk.length
      if (length <= 384_000) chunks.push(chunk)
    })
    request.on('end', () => {
      if (length > 384_000) { response.writeHead(413).end(); return }
      void speedOcr.recognize(Buffer.concat(chunks)).then(result => {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        response.end(JSON.stringify(result))
      }).catch(() => {
        response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        response.end(JSON.stringify({ error: 'Speed OCR unavailable' }))
      })
    })
    return
  }
  if (url.pathname === '/diagnostics' && request.method === 'POST') {
    receiveBrowserDiagnostic(request, response)
    return
  }
  if (url.pathname === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify({
      ok: true,
      runtime: 'browser',
      version: process.env.ROUND_CARPLAY_VERSION || null,
      playportConfigured: playPortBridge.configured,
      speedOcr: speedOcr.getStatus()
    }))
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
    'Cache-Control': file.endsWith('index.html')
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

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`)
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
  piUpdater.stop()
  if (brightnessOwner) await releaseBrightness(brightnessOwner, true)
  io?.close()
  httpServer.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 5_000).unref()
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
