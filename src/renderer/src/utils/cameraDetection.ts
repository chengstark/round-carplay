import { ExtraConfig } from "../../../main/Globals"

export async function updateCameras(
  setCameraFound: (found: boolean) => void,
  saveSettings: (cfg: ExtraConfig) => void,
  currentSettings: ExtraConfig
): Promise<MediaDeviceInfo[]> {
  try {
    let devs = await navigator.mediaDevices.enumerateDevices()
    let cams = devs.filter(d => d.kind === 'videoinput')
    if (cams.length > 0 && cams.every(camera => !camera.label)) {
      try {
        const permissionStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
        permissionStream.getTracks().forEach(track => track.stop())
        devs = await navigator.mediaDevices.enumerateDevices()
        cams = devs.filter(d => d.kind === 'videoinput')
      } catch (error) {
        console.warn('[CameraDetection] camera permission was not granted', error)
      }
    }
    setCameraFound(cams.length > 0)

    const selectedCameraIsConnected = cams.some(camera => camera.deviceId === currentSettings.camera)
    if (!selectedCameraIsConnected && cams.length > 0) {
      const preferredCamera = cams.find(camera => /(^|\b)2504(\b|$)/i.test(camera.label))
        ?? cams.find(camera => /usb camera|icspring/i.test(camera.label))
        ?? cams[0]
      const updated = { ...currentSettings, camera: preferredCamera.deviceId }
      saveSettings(updated)
    }

    return cams
  } catch (err) {
    console.warn('[CameraDetection] enumerateDevices failed', err)
    return []
  }
}
