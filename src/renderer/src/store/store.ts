import { create } from 'zustand'
import { ExtraConfig } from '../../../main/Globals'

// Carplay Store
export interface CarplayStore {
  // App-Einstellungen
  settings: ExtraConfig | null
  saveSettings: (settings: ExtraConfig) => void
  getSettings: () => void
  stream: (stream: any) => void
  resetInfo: () => void

  // Display-Resolution
  negotiatedWidth: number | null
  negotiatedHeight: number | null

  // USB Device Info
  serial: string | null
  manufacturer: string | null
  product: string | null
  fwVersion: string | null

  // Setter
  setDeviceInfo: (info: {
    serial: string
    manufacturer: string
    product: string
    fwVersion: string
  }) => void
  setNegotiatedResolution: (width: number, height: number) => void
}

export const useCarplayStore = create<CarplayStore>((set) => ({
  settings: null,
  saveSettings: (settings) => {
    set({ settings })
    window.carplay.settings.save(settings).catch((error) => {
      console.error('Could not save settings', error)
    })
  },
  getSettings: () => {
    window.carplay.settings.get().then((settings) => set({ settings })).catch((error) => {
      console.error('Could not load settings', error)
    })
  },
  stream: (stream) => {
    void stream
  },

  // Reset all stored info
  resetInfo: () =>
    set({
      negotiatedWidth: null,
      negotiatedHeight: null,
      serial: null,
      manufacturer: null,
      product: null,
      fwVersion: null,
    }),

  negotiatedWidth: null,
  negotiatedHeight: null,
  serial: null,
  manufacturer: null,
  product: null,
  fwVersion: null,

  setDeviceInfo: ({ serial, manufacturer, product, fwVersion }) =>
    set({ serial, manufacturer, product, fwVersion }),

  setNegotiatedResolution: (width, height) =>
    set({ negotiatedWidth: width, negotiatedHeight: height }),
}))

// Status store
export interface StatusStore {
  reverse: boolean
  lights: boolean

  // Dongle- und Streaming-Status
  isDongleConnected: boolean
  isStreaming: boolean
  cameraFound: boolean

  setCameraFound: (found: boolean) => void
  setDongleConnected: (connected: boolean) => void
  setStreaming: (streaming: boolean) => void
  setReverse: (reverse: boolean) => void
  setLights: (lights: boolean) => void
}

export const useStatusStore = create<StatusStore>((set) => ({
  reverse: false,
  lights: false,
  isDongleConnected: false,
  isStreaming: false,
  cameraFound: false,

  setCameraFound: (found) => set({ cameraFound: found }),
  setDongleConnected: (connected) => set({ isDongleConnected: connected }),
  setStreaming: (streaming) => set({ isStreaming: streaming }),
  setReverse: (reverse) => set({ reverse }),
  setLights: (lights) => set({ lights }),
}))

window.carplay.settings.onUpdate((_event, settings: ExtraConfig) => {
  useCarplayStore.setState({ settings })
})

window.carplay.settings.get().then((settings) => {
  useCarplayStore.setState({ settings })
}).catch((error) => console.error('Could not load settings', error))
