import type { ExtraConfig, WifiCameraOptions } from '../main/Globals'
import type { GpsState } from '../main/gps/GpsService'
import type {
  BluetoothActionResult,
  BluetoothSnapshot
} from '../main/bluetooth/BluetoothService'
import type { IpAddress, NetworkSnapshot, WifiConnectResult } from '../main/network/NetworkService'
import type {
  RuntimeKind,
  RuntimeSwitchResult,
  RuntimeSwitchStatus
} from '../main/runtime/RuntimeSwitchService'
import type {
  SystemPowerOffResult,
  SystemRebootResult,
  SystemUpdateStatus
} from '../main/update/SystemUpdateService'
import type { WifiCameraDiagnostics, WifiCameraStartResult } from '../main/wifi/WifiCameraService'

export type ApiCallback<T = unknown> = (event: unknown, ...args: T[]) => void
export type RemoveListener = () => void

export type UsbEvent = {
  type: string
  device: { vendorId: number; productId: number; deviceName: string } | null
}

export type UsbDeviceInfo = {
  device: boolean
  vendorId: number | null
  productId: number | null
  deviceName?: string
  serialNumber: string
  manufacturerName: string
  productName: string
  fwVersion: string
}

export interface CarplayApi {
  quit(): Promise<unknown>
  onUSBResetStatus(callback: ApiCallback<boolean>): void
  usb: {
    forceReset(): Promise<boolean>
    detectDongle(): Promise<boolean>
    getDeviceInfo(): Promise<UsbDeviceInfo>
    getLastEvent(): Promise<UsbEvent>
    getSysdefaultPrettyName(): Promise<string>
    listenForEvents(callback: ApiCallback<any>): void
    unlistenForEvents(callback: ApiCallback<any>): void
  }
  settings: {
    get(): Promise<ExtraConfig>
    save(settings: ExtraConfig): Promise<unknown>
    onUpdate(callback: ApiCallback<ExtraConfig>): unknown
  }
  wifiCamera: {
    start(options: WifiCameraOptions): Promise<WifiCameraStartResult>
    configure(options: WifiCameraOptions): Promise<WifiCameraStartResult>
    stop(): Promise<unknown>
    acknowledgeFrame(): void
    onFrame(callback: (frame: Uint8Array) => void): RemoveListener
    onStatus(
      callback: (status: {
        state: 'connecting' | 'streaming' | 'error' | 'stopped'
        message: string
      }) => void
    ): RemoveListener
    onDiagnostics(callback: (diagnostics: WifiCameraDiagnostics) => void): RemoveListener
  }
  gps: {
    getState(): Promise<GpsState>
    onState(callback: (state: GpsState) => void): RemoveListener
  }
  network: {
    scanWifi(): Promise<NetworkSnapshot>
    connectWifi(ssid: string, password: string): Promise<WifiConnectResult>
    getIpAddresses(): Promise<IpAddress[]>
  }
  bluetooth: {
    scan(): Promise<BluetoothSnapshot>
    connect(address: string): Promise<BluetoothActionResult>
    disconnect(address: string): Promise<BluetoothActionResult>
  }
  update: {
    getStatus(): Promise<SystemUpdateStatus>
    start(): Promise<SystemUpdateStatus>
    reboot(): Promise<SystemRebootResult>
    powerOff(): Promise<SystemPowerOffResult>
    onStatus(callback: (status: SystemUpdateStatus) => void): RemoveListener
  }
  runtime: {
    getStatus(): Promise<RuntimeSwitchStatus>
    switchTo(target: RuntimeKind): Promise<RuntimeSwitchResult>
  }
  ipc: {
    start(): Promise<unknown>
    stop(): Promise<unknown>
    sendFrame(): Promise<unknown>
    sendTouch(x: number, y: number, action: number): void
    sendKeyCommand(key: string): void
    onEvent(callback: ApiCallback<any>): unknown
    onVideoChunk(handler: (payload: any) => void): void
    onAudioChunk(handler: (payload: any) => void): void
  }
}
