import { useEffect, useRef, useState } from 'react'
import { FormControl, IconButton, MenuItem, Select, Slider, Stack, Typography } from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import CheckIcon from '@mui/icons-material/Check'
import CloseIcon from '@mui/icons-material/Close'
import RemoveIcon from '@mui/icons-material/Remove'
import TuneIcon from '@mui/icons-material/Tune'
import {
  WIFI_CAMERA_RESOLUTIONS,
  type WifiCameraFrameSize,
  type WifiCameraOptions,
  type WifiCameraRotation
} from '../../../main/Globals'
import ParkingGuides from './ParkingGuides'

type CameraStatus = {
  state: 'connecting' | 'streaming' | 'error' | 'stopped'
  message: string
}

/** Integrated XIAO ESP32-S3 Wi-Fi camera surface. The USB Camera component remains
 * separate and continues to back the existing /camera route. */
export default function WifiCamera({
  rotation,
  cameraOptions,
  onRotationSave,
  onCameraOptionsSave,
  onExit
}: {
  rotation: WifiCameraRotation
  cameraOptions: WifiCameraOptions
  onRotationSave: (rotation: WifiCameraRotation) => void
  onCameraOptionsSave: (options: WifiCameraOptions) => void
  onExit: () => void
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rotationRef = useRef<WifiCameraRotation>(rotation)
  const [calibrating, setCalibrating] = useState(false)
  const [draftRotation, setDraftRotation] = useState(rotation)
  const [draftFrameSize, setDraftFrameSize] = useState(cameraOptions.frameSize)
  const [draftJpegQuality, setDraftJpegQuality] = useState(cameraOptions.jpegQuality)
  const [hasFrame, setHasFrame] = useState(false)
  const [status, setStatus] = useState<CameraStatus>({
    state: 'connecting',
    message: 'Connecting to Wi-Fi camera…'
  })

  useEffect(() => {
    if (!calibrating) {
      rotationRef.current = rotation
      setDraftRotation(rotation)
    }
  }, [rotation, calibrating])

  useEffect(() => {
    if (!calibrating) {
      setDraftFrameSize(cameraOptions.frameSize)
      setDraftJpegQuality(cameraOptions.jpegQuality)
    }
  }, [cameraOptions.frameSize, cameraOptions.jpegQuality, calibrating])

  const updateDraftRotation = (value: number): void => {
    const rounded = Math.round(value)
    const normalized = ((rounded % 360) + 360) % 360
    rotationRef.current = normalized
    setDraftRotation(normalized)
  }

  const toggleCalibration = (): void => {
    if (calibrating) {
      onRotationSave(draftRotation)
      setCalibrating(false)
      return
    }

    rotationRef.current = rotation
    setDraftRotation(rotation)
    setCalibrating(true)
  }

  const applyCameraTuning = async (
    frameSize: WifiCameraFrameSize,
    jpegQuality: number
  ): Promise<void> => {
    const next = { ...cameraOptions, frameSize, jpegQuality }
    setDraftFrameSize(frameSize)
    setDraftJpegQuality(jpegQuality)
    onCameraOptionsSave(next)

    const result = await window.carplay.wifiCamera.configure(next)
    if (!result.ok) {
      setStatus({ state: 'error', message: result.error ?? 'Camera tuning failed' })
    }
  }

  useEffect(() => {
    let active = true

    const removeStatusListener = window.carplay.wifiCamera.onStatus((next) => {
      if (active) setStatus(next)
    })

    const removeFrameListener = window.carplay.wifiCamera.onFrame(async (frame) => {
      try {
        const bytes = new Uint8Array(frame.byteLength)
        bytes.set(frame)
        const bitmap = await createImageBitmap(new Blob([bytes.buffer], { type: 'image/jpeg' }))

        if (!active) {
          bitmap.close()
          return
        }

        const canvas = canvasRef.current
        if (!canvas) {
          bitmap.close()
          return
        }

        const bounds = canvas.getBoundingClientRect()
        const pixelRatio = window.devicePixelRatio || 1
        const width = Math.max(1, Math.round(bounds.width * pixelRatio))
        const height = Math.max(1, Math.round(bounds.height * pixelRatio))
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width
          canvas.height = height
        }

        const context = canvas.getContext('2d', { alpha: false })
        if (context) {
          const currentRotation = rotationRef.current
          const radians = (currentRotation * Math.PI) / 180

          // The canvas is a fixed 16:9 viewport. Rotate only the camera image,
          // then scale it far enough to cover the viewport at every angle.
          // Canvas clipping keeps the visible camera surface rectangular while
          // avoiding empty triangles around a corrected/rotated image.
          const cosine = Math.abs(Math.cos(radians))
          const sine = Math.abs(Math.sin(radians))
          const scale = Math.max(
            (cosine * width + sine * height) / bitmap.width,
            (sine * width + cosine * height) / bitmap.height
          )
          const drawWidth = bitmap.width * scale
          const drawHeight = bitmap.height * scale

          context.setTransform(1, 0, 0, 1, 0, 0)
          context.fillStyle = '#000'
          context.fillRect(0, 0, width, height)
          context.save()
          context.translate(width / 2, height / 2)
          context.rotate(radians)
          context.drawImage(
            bitmap,
            -drawWidth / 2,
            -drawHeight / 2,
            drawWidth,
            drawHeight
          )
          context.restore()
          setHasFrame(true)
        }
        bitmap.close()
      } catch (error) {
        console.error('[WifiCamera] JPEG decode failed', error)
      } finally {
        window.carplay.wifiCamera.acknowledgeFrame()
      }
    })

    window.carplay.wifiCamera.start(cameraOptions).then(result => {
      if (active && !result.ok) {
        setStatus({ state: 'error', message: result.error ?? 'Camera connection failed' })
      }
    }).catch((error) => {
      if (active) {
        setStatus({
          state: 'error',
          message: error instanceof Error ? error.message : String(error)
        })
      }
    })

    return () => {
      active = false
      removeFrameListener()
      removeStatusListener()
      window.carplay.wifiCamera.stop().catch((error) => {
        console.warn('[WifiCamera] Stop failed', error)
      })
    }
  }, [])

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        background: '#000'
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          width: '87%',
          aspectRatio: '16 / 9',
          transform: 'translate(-50%, -50%)',
          overflow: 'hidden',
          background: '#000'
        }}
      >
        <canvas
          ref={canvasRef}
          aria-label="Wi-Fi backup camera"
          style={{ width: '100%', height: '100%', display: 'block' }}
        />
        <ParkingGuides />

        {!hasFrame && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '12%',
              textAlign: 'center',
              color: '#fff',
              background: 'rgba(0,0,0,0.72)'
            }}
          >
            <Typography variant="h6">
              {status.state === 'error' ? 'Wi-Fi Camera Unavailable' : 'Wi-Fi Camera'}
            </Typography>
            <Typography variant="body2" sx={{ mt: 1, opacity: 0.8 }}>
              {status.message}
            </Typography>
            {status.state === 'error' && (
              <Typography variant="caption" sx={{ mt: 1.5, opacity: 0.65 }}>
                Connect this device to the XIAO camera Wi-Fi network.
              </Typography>
            )}
          </div>
        )}
      </div>

      <IconButton
        aria-label="Exit Wi-Fi backup camera"
        title="Exit camera"
        onClick={onExit}
        sx={{
          position: 'absolute',
          top: '17%',
          left: '20%',
          zIndex: 6,
          width: 52,
          height: 52,
          color: '#fff',
          border: '1px solid rgba(255,255,255,0.65)',
          backgroundColor: 'rgba(0,0,0,0.72)',
          boxShadow: '0 2px 10px rgba(0,0,0,0.55)',
          '&:hover': { backgroundColor: 'rgba(0,0,0,0.72)' }
        }}
      >
        <CloseIcon />
      </IconButton>

      <IconButton
        aria-label={calibrating ? 'Save camera rotation' : 'Adjust camera rotation'}
        title={calibrating ? 'Save camera rotation' : 'Adjust camera rotation'}
        onClick={toggleCalibration}
        sx={{
          position: 'absolute',
          top: '13%',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 5,
          width: 52,
          height: 52,
          color: '#fff',
          border: '1px solid rgba(255,255,255,0.55)',
          backgroundColor: calibrating ? 'rgba(38,122,70,0.9)' : 'rgba(0,0,0,0.68)',
          boxShadow: '0 2px 10px rgba(0,0,0,0.55)',
          '&:hover': {
            backgroundColor: calibrating ? 'rgba(38,122,70,0.9)' : 'rgba(0,0,0,0.68)'
          }
        }}
      >
        {calibrating ? <CheckIcon /> : <TuneIcon />}
      </IconButton>

      {calibrating && (
        <div
          style={{
            position: 'absolute',
            top: '25%',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 4,
            width: '78%',
            padding: '12px 22px 10px',
            borderRadius: 14,
            color: '#fff',
            background: 'rgba(0,0,0,0.72)',
            boxShadow: '0 3px 14px rgba(0,0,0,0.5)'
          }}
        >
          <Typography variant="subtitle2" align="center">
            Rotation {draftRotation}°
          </Typography>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12
            }}
          >
            <IconButton
              aria-label="Rotate camera one degree counter-clockwise"
              title="Rotate −1°"
              onClick={() => updateDraftRotation(draftRotation - 1)}
              sx={{
                flex: '0 0 auto',
                width: 48,
                height: 48,
                color: '#fff',
                border: '1px solid rgba(255,255,255,0.5)',
                backgroundColor: 'rgba(255,255,255,0.1)'
              }}
            >
              <RemoveIcon />
            </IconButton>
            <Slider
              aria-label="Wi-Fi camera rotation"
              value={draftRotation}
              min={0}
              max={359}
              step={1}
              marks={[
                { value: 0, label: '0°' },
                { value: 90, label: '90°' },
                { value: 180, label: '180°' },
                { value: 270, label: '270°' },
                { value: 359, label: '359°' }
              ]}
              valueLabelDisplay="auto"
              valueLabelFormat={(value) => `${value}°`}
              onChange={(_, value) => {
                if (typeof value === 'number') updateDraftRotation(value)
              }}
              sx={{
                minWidth: 0,
                color: '#e6e3db',
                '& .MuiSlider-markLabel': { color: 'rgba(255,255,255,0.78)' }
              }}
            />
            <IconButton
              aria-label="Rotate camera one degree clockwise"
              title="Rotate +1°"
              onClick={() => updateDraftRotation(draftRotation + 1)}
              sx={{
                flex: '0 0 auto',
                width: 48,
                height: 48,
                color: '#fff',
                border: '1px solid rgba(255,255,255,0.5)',
                backgroundColor: 'rgba(255,255,255,0.1)'
              }}
            >
              <AddIcon />
            </IconButton>
          </div>
          <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 1 }}>
            <FormControl size="small" sx={{ minWidth: 155 }}>
              <Select
                aria-label="Wi-Fi camera resolution"
                value={draftFrameSize}
                onChange={event => {
                  const frameSize = Number(event.target.value) as WifiCameraFrameSize
                  void applyCameraTuning(frameSize, draftJpegQuality)
                }}
                sx={{
                  color: '#fff',
                  backgroundColor: 'rgba(255,255,255,0.1)',
                  '& .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(255,255,255,0.45)' },
                  '& .MuiSvgIcon-root': { color: '#fff' }
                }}
              >
                {WIFI_CAMERA_RESOLUTIONS.map(resolution => (
                  <MenuItem key={resolution.value} value={resolution.value}>
                    {resolution.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Typography variant="caption" display="block" align="center">
                JPEG compression {draftJpegQuality}
              </Typography>
              <Slider
                aria-label="Wi-Fi camera JPEG compression"
                value={draftJpegQuality}
                min={4}
                max={63}
                step={1}
                valueLabelDisplay="auto"
                onChange={(_, value) => {
                  if (typeof value === 'number') setDraftJpegQuality(value)
                }}
                onChangeCommitted={(_, value) => {
                  if (typeof value === 'number') {
                    void applyCameraTuning(draftFrameSize, value)
                  }
                }}
                sx={{ color: '#e6e3db' }}
              />
            </div>
          </Stack>
          <Typography variant="caption" display="block" align="center" sx={{ opacity: 0.72 }}>
            Higher compression values usually reduce latency. Changes apply live and are saved.
          </Typography>
          <Typography
            variant="caption"
            display="block"
            align="center"
            color={status.state === 'error' ? '#ff9a9a' : 'inherit'}
            sx={{ mt: 0.5, opacity: 0.82 }}
          >
            {status.message}
          </Typography>
        </div>
      )}
    </div>
  )
}
