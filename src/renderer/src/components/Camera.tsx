import React from 'react'
import type { ExtraConfig } from '../../../main/Globals'
import UsbCamera from './UsbCamera'

interface CameraProps { settings: ExtraConfig | null }

const Camera: React.FC<CameraProps> = ({ settings }) => (
  <UsbCamera
    deviceId={settings?.camera ?? ''}
    rotation={settings?.cameraRotation ?? 0}
    resolution={settings?.cameraResolution ?? '1280x720'}
    horizontalFlip={settings?.cameraHorizontalFlip ?? false}
    verticalFlip={settings?.cameraVerticalFlip ?? false}
    showControls={false}
  />
)

export default Camera
