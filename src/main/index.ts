import { app, shell, BrowserWindow, session, ipcMain, protocol } from 'electron'
import { join, extname } from 'path'
import { existsSync, createReadStream, readFileSync, writeFileSync } from 'fs'
import { electronApp, is } from '@electron-toolkit/utils'
import { DEFAULT_CONFIG } from '@carplay/node'
import { Socket } from './Socket'
import { ExtraConfig, KeyBindings, WifiCameraFrameSize, WIFI_CAMERA_RESOLUTIONS } from './Globals'
import { USBService } from './usb/USBService'
import { CarplayService } from './carplay/CarplayService'
import { WifiCameraService } from './wifi/WifiCameraService'
import { GpsService } from './gps/GpsService'
import { NetworkService } from './network/NetworkService'
import { SystemUpdateService } from './update/SystemUpdateService'
import { OtaUpdateService } from './update/OtaUpdateService'
import { RuntimeSwitchService } from './runtime/RuntimeSwitchService'
import type { ServiceEventSink } from './events/ServiceEventSink'

// Important: On Linux, enabling VA-API flags breaks WebCodecs’ hardware fallback path.
// Requesting ‘prefer-hardware’ without a valid VA-API backend will immediately close the decoder.
// Therefore on Linux we default to ‘prefer-software’ and only switch to hardware after confirming support.
// On macOS, the WebCodecs hardware accelerator is available, so this Linux-specific fallback logic is not needed.

// Feature-Flags
app.commandLine.appendSwitch(
  'enable-features',
  [
    'AcceleratedVideoEncoder',
    'AcceleratedVideoDecodeLinuxGL',
    'AcceleratedVideoDecodeLinuxZeroCopyGL'
  ].join(',')
)

// EGL/ANGLE for OpenGL
app.commandLine.appendSwitch('use-gl', 'angle')
app.commandLine.appendSwitch('use-angle', 'gl')

// Disable blocklist & workarounds
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('disable-gpu-driver-bug-workaround')

// GPU rasterization
app.commandLine.appendSwitch('enable-gpu-rasterization')

if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('enable-unsafe-webgpu')
  app.commandLine.appendSwitch('enable-dawn-features')
}

app.on('gpu-info-update', () => {
  console.log('GPU Info:', app.getGPUFeatureStatus())
})

const mimeTypeFromExt = (ext: string): string =>
  ({
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.map': 'application/json'
  })[ext.toLowerCase()] ?? 'application/octet-stream'

const MIN_WIDTH = 400

function applyAspectRatio(win: BrowserWindow, width: number, height: number): void {
  if (!win) return

  const ratio = width && height ? width / height : 0

  const [winW, winH] = win.getSize()
  const [contentW, contentH] = win.getContentSize()
  const extraWidth = Math.max(0, winW - contentW)
  const extraHeight = Math.max(0, winH - contentH)

  win.setAspectRatio(ratio, { width: extraWidth, height: extraHeight })

  if (ratio > 0) {
    const minH = Math.round(MIN_WIDTH / ratio)
    win.setMinimumSize(MIN_WIDTH + extraWidth, minH + extraHeight)
  } else {
    win.setMinimumSize(0, 0)
  }
}

// Globals
let mainWindow: BrowserWindow | null
let socket: Socket
let config: ExtraConfig
let usbService: USBService
let isQuitting = false

const appPath = app.getPath('userData')
const configPath = join(appPath, 'config.json')
const electronEvents: ServiceEventSink = {
  send(channel, payload) {
    const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed())
    windows.forEach((window) => window.webContents.send(channel, payload))
    return windows.length > 0
  }
}
const carplayService = new CarplayService(electronEvents, appPath)
const wifiCameraService = new WifiCameraService(electronEvents)
const gpsService = new GpsService(undefined, electronEvents)
const networkService = new NetworkService()
const systemUpdateService = new SystemUpdateService()
const otaUpdateService = new OtaUpdateService(() => wifiCameraService.isActive())
const runtimeSwitchService = new RuntimeSwitchService()
;(global as any).carplayService = carplayService

app.on('before-quit', async (e) => {
  if (isQuitting) return
  isQuitting = true
  e.preventDefault()
  try {
    carplayService.prepareForShutdown()
    wifiCameraService.stop()
    gpsService.stop()
    await carplayService.stop()
    await usbService?.forceReset()
    await usbService.stop()
  } catch (err) {
    console.warn('Error while quitting:', err)
  } finally {
    app.exit(0)
  }
})

// Protocol & Config
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      secure: true,
      standard: true,
      corsEnabled: true,
      supportFetchAPI: true,
      stream: true
    }
  }
])

const DEFAULT_BINDINGS: KeyBindings = {
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  selectUp: 'KeyB',
  selectDown: 'Space',
  back: 'Backspace',
  home: 'KeyH',
  play: 'KeyP',
  pause: 'KeyO',
  next: 'KeyM',
  prev: 'KeyN'
}

function loadConfig(): ExtraConfig {
  let fileConfig: Partial<ExtraConfig> = {}
  if (existsSync(configPath)) {
    fileConfig = JSON.parse(readFileSync(configPath, 'utf8'))
  }

  const merged: ExtraConfig = {
    ...DEFAULT_CONFIG,
    kiosk: true,
    camera: '',
    backgroundColor: '#000000',
    wifiCameraRotation: 0,
    wifiCameraHost: '192.168.10.1',
    wifiCameraFrameSize: 8,
    wifiCameraJpegQuality: 20,
    wifiCameraHorizontalFlip: false,
    gpsSmoothing: 0.55,
    microphone: '',
    nightMode: true,
    audioVolume: 1.0,
    navVolume: 0.5,
    outputGain: 10,
    bindings: { ...DEFAULT_BINDINGS },
    ...fileConfig
  } as ExtraConfig

  merged.bindings = {
    ...DEFAULT_BINDINGS,
    ...(fileConfig.bindings || {})
  }
  merged.backgroundColor = normalizeBackgroundColor(merged.backgroundColor)
  merged.wifiCameraRotation = normalizeWifiCameraRotation(merged.wifiCameraRotation)
  merged.wifiCameraHost = normalizeWifiCameraHost(merged.wifiCameraHost)
  merged.wifiCameraFrameSize = normalizeWifiCameraFrameSize(merged.wifiCameraFrameSize)
  merged.wifiCameraJpegQuality = normalizeWifiCameraJpegQuality(merged.wifiCameraJpegQuality)
  merged.wifiCameraHorizontalFlip = normalizeWifiCameraHorizontalFlip(merged.wifiCameraHorizontalFlip)
  merged.gpsSmoothing = normalizeGpsSmoothing(merged.gpsSmoothing)
  merged.outputGain = normalizeOutputGain(merged.outputGain)

  const needWrite = !existsSync(configPath) || JSON.stringify(fileConfig) !== JSON.stringify(merged)

  if (needWrite) {
    writeFileSync(configPath, JSON.stringify(merged, null, 2))
    console.log('[config] Written complete config.json with all defaults')
  }

  return merged
}

config = loadConfig()
gpsService.setSmoothing(config.gpsSmoothing)

// Window
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: config.width,
    height: config.height,
    frame: !config.kiosk,
    useContentSize: true,
    kiosk: false,
    autoHideMenuBar: true,
    backgroundColor: '#000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: true
    }
  })

  const ses = mainWindow.webContents.session
  ses.setPermissionCheckHandler((_w, p) => ['usb', 'hid', 'media', 'display-capture'].includes(p))
  ses.setPermissionRequestHandler((_w, p, cb) =>
    cb(['usb', 'hid', 'media', 'display-capture'].includes(p))
  )
  ses.setUSBProtectedClassesHandler(({ protectedClasses }) =>
    protectedClasses.filter((c) => ['audio', 'video', 'vendor-specific'].includes(c))
  )

  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['*://*/*', 'file://*/*'] },
    (d, cb) =>
      cb({
        responseHeaders: {
          ...d.responseHeaders,
          'Cross-Origin-Opener-Policy': ['same-origin'],
          'Cross-Origin-Embedder-Policy': ['require-corp'],
          'Cross-Origin-Resource-Policy': ['same-site']
        }
      })
  )

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return
    mainWindow.show()

    if (config.kiosk) {
      mainWindow.setKiosk(true)
      applyAspectRatio(mainWindow, 0, 0)
    } else {
      mainWindow.setContentSize(config.width, config.height, false)
      applyAspectRatio(mainWindow, config.width, config.height)
    }

    if (is.dev) mainWindow.webContents.openDevTools({ mode: 'detach' })
    electronEvents.send('gps-state', gpsService.getState())
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL)
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else mainWindow.loadURL('app://index.html')

  // macOS hide
  mainWindow.on('close', (e) => {
    if (process.platform === 'darwin' && !isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  // chrome://gpu
  if (is.dev) {
    const gpuWindow = new BrowserWindow({
      width: 1000,
      height: 800,
      title: 'GPU Info',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    })
    gpuWindow.loadURL('chrome://gpu')
  }
  // chrome://media-internals
  if (is.dev) {
    const mediaWindow = new BrowserWindow({
      width: 1000,
      height: 800,
      title: 'GPU Info',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    })
    mediaWindow.loadURL('chrome://media-internals')
  }
}

// App‑Lifecycle
app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron.carplay')

  protocol.registerStreamProtocol('app', (request, cb) => {
    try {
      const u = new URL(request.url)
      let path = decodeURIComponent(u.pathname)
      if (path === '/' || path === '') path = '/index.html'
      const file = join(__dirname, '../renderer', path)
      if (!existsSync(file)) return cb({ statusCode: 404 })
      cb({
        statusCode: 200,
        headers: {
          'Content-Type': mimeTypeFromExt(extname(file)),
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
          'Cross-Origin-Resource-Policy': 'same-site'
        },
        data: createReadStream(file)
      })
    } catch (e) {
      console.error('[app-protocol] error', e)
      cb({ statusCode: 500 })
    }
  })

  usbService = new USBService(carplayService, electronEvents)
  socket = new Socket(config, saveSettings)

  ipcMain.handle('quit', () => (process.platform === 'darwin' ? mainWindow?.hide() : app.quit()))
  ipcMain.handle('carplay-start', () => carplayService.start())
  ipcMain.handle('carplay-stop', () => carplayService.stop())
  ipcMain.handle('carplay-sendframe', () => carplayService.sendFrame())
  ipcMain.on('carplay-touch', (_event, data) => {
    carplayService.sendTouch(data.x, data.y, data.action)
  })
  ipcMain.on('carplay-key-command', (_event, command) => {
    carplayService.sendKeyCommand(command)
  })
  ipcMain.handle('usb-force-reset', () => usbService.forceReset())
  ipcMain.handle('usb-detect-dongle', () => usbService.detectDongle())
  ipcMain.handle('carplay:usbDevice', () => usbService.getDeviceInfo())
  ipcMain.handle('usb-last-event', () => usbService.getLastEvent())
  ipcMain.handle('get-sysdefault-mic-label', () => usbService.getSysdefaultPrettyName())
  ipcMain.handle('getSettings', () => config)
  ipcMain.handle('save-settings', (_event, settings: ExtraConfig) => saveSettings(settings))
  ipcMain.handle('wifi-camera-start', async (_event, options) => {
    const connection = await networkService.connectCameraWifi()
    if (!connection.ok) {
      console.warn(`[WifiCamera] Camera Wi-Fi connection failed: ${connection.message}`)
      return { ok: false, error: connection.message }
    }
    return wifiCameraService.start(options)
  })
  ipcMain.handle('wifi-camera-configure', (_event, options) => wifiCameraService.configure(options))
  ipcMain.handle('wifi-camera-stop', async () => {
    wifiCameraService.stop()
    return networkService.restoreCameraWifi()
  })
  ipcMain.on('wifi-camera-frame-ack', () => wifiCameraService.acknowledgeFrame())
  ipcMain.handle('gps-get-state', () => gpsService.getState())
  ipcMain.handle('network-scan-wifi', () => networkService.scanWifi())
  ipcMain.handle('network-connect-wifi', (_event, ssid: string, password: string) =>
    networkService.connectWifi(ssid, password)
  )
  ipcMain.handle('network-get-ip-addresses', () => networkService.getIpAddresses())
  ipcMain.handle('system-update-get-status', () =>
    otaUpdateService.isConfigured() ? otaUpdateService.getStatus() : systemUpdateService.getStatus()
  )
  ipcMain.handle('system-update-start', event =>
    (otaUpdateService.isConfigured() ? otaUpdateService : systemUpdateService).update(status => {
        if (!event.sender.isDestroyed()) event.sender.send('system-update-status', status)
      })
  )
  ipcMain.handle('system-update-reboot', () => systemUpdateService.reboot())
  ipcMain.handle('system-power-off', () => systemUpdateService.powerOff())
  ipcMain.handle('runtime-get-status', () => runtimeSwitchService.getStatus('electron'))
  ipcMain.handle('runtime-switch-to', async (_event, target) => {
    if (target !== 'browser') return { ok: false, message: 'Invalid runtime switch target' }
    const switchResult = await runtimeSwitchService.switchTo('electron', target)
    if (!switchResult.ok) return switchResult

    const rebootResult = await systemUpdateService.reboot()
    if (rebootResult.ok) {
      return { ok: true, message: 'Switching to the browser version…' }
    }

    return {
      ok: false,
      message: `${switchResult.message}, but the reboot failed: ${rebootResult.message}`
    }
  })

  createWindow()
  gpsService.start().catch((error) => console.error('[GPS] Startup failed', error))
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && !mainWindow) createWindow()
    else mainWindow?.show()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Settings IPC
function saveSettings(settings: ExtraConfig) {
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        ...settings,
        width: +settings.width,
        height: +settings.height,
        fps: +settings.fps,
        dpi: +settings.dpi,
        format: +settings.format,
        iBoxVersion: +settings.iBoxVersion,
        phoneWorkMode: +settings.phoneWorkMode,
        packetMax: +settings.packetMax,
        mediaDelay: +settings.mediaDelay,
        backgroundColor: normalizeBackgroundColor(settings.backgroundColor),
        wifiCameraRotation: normalizeWifiCameraRotation(settings.wifiCameraRotation),
        wifiCameraHost: normalizeWifiCameraHost(settings.wifiCameraHost),
        wifiCameraFrameSize: normalizeWifiCameraFrameSize(settings.wifiCameraFrameSize),
        wifiCameraJpegQuality: normalizeWifiCameraJpegQuality(settings.wifiCameraJpegQuality),
        wifiCameraHorizontalFlip: normalizeWifiCameraHorizontalFlip(settings.wifiCameraHorizontalFlip),
        gpsSmoothing: normalizeGpsSmoothing(settings.gpsSmoothing),
        outputGain: normalizeOutputGain(settings.outputGain)
      },
      null,
      2
    )
  )

  const gpsSmoothing = normalizeGpsSmoothing(settings.gpsSmoothing)
  const outputGain = normalizeOutputGain(settings.outputGain)
  config = { ...settings, gpsSmoothing, outputGain }
  gpsService.setSmoothing(gpsSmoothing)
  socket.config = { ...settings, gpsSmoothing, outputGain }
  socket.sendSettings()
  electronEvents.send('settings', config)

  if (!mainWindow) return config

  if (settings.kiosk) {
    mainWindow.setKiosk(true)
    applyAspectRatio(mainWindow, 0, 0)
  } else {
    mainWindow.setKiosk(false)
    mainWindow.setContentSize(settings.width, settings.height, false)
    applyAspectRatio(mainWindow, settings.width, settings.height)
  }
  return config
}

function normalizeWifiCameraRotation(value: unknown): number {
  const rotation = Number(value)
  if (!Number.isFinite(rotation)) return 0
  return ((rotation % 360) + 360) % 360
}

function normalizeWifiCameraHost(value: unknown): string {
  const candidate = String(value ?? '').trim()
  if (!candidate) return '192.168.10.1'

  try {
    const url = new URL(candidate.includes('://') ? candidate : `http://${candidate}`)
    return url.hostname || '192.168.10.1'
  } catch {
    return '192.168.10.1'
  }
}

function normalizeWifiCameraFrameSize(value: unknown): WifiCameraFrameSize {
  const frameSize = Number(value)
  const supported = WIFI_CAMERA_RESOLUTIONS.some(resolution => resolution.value === frameSize)
  return supported ? frameSize as WifiCameraFrameSize : 8
}

function normalizeWifiCameraJpegQuality(value: unknown): number {
  const quality = Math.round(Number(value))
  if (!Number.isFinite(quality)) return 20
  return Math.min(63, Math.max(4, quality))
}

function normalizeWifiCameraHorizontalFlip(value: unknown): boolean {
  return value === true
}

function normalizeGpsSmoothing(value: unknown): number {
  const smoothing = Number(value)
  if (!Number.isFinite(smoothing)) return 0.55
  return Math.min(0.9, Math.max(0, smoothing))
}

function normalizeOutputGain(value: unknown): number {
  const gain = Number(value)
  if (!Number.isFinite(gain)) return 10
  return Math.min(100, Math.max(5, Math.round(gain / 5) * 5))
}

function normalizeBackgroundColor(value: unknown): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'
}
