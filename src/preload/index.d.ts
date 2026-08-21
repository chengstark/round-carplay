import { ElectronAPI } from '@electron-toolkit/preload'
import type { Api } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    carplay: Api
    api: Api
    electronAPI: Api
  }
}

export {}
