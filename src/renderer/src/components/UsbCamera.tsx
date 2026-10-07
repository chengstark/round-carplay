import { useEffect, useRef, useState } from 'react'
import {
  FormControl,
  FormControlLabel,
  IconButton,
  MenuItem,
  Select,
  Slider,
  Stack,
  Switch,
  Typography
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import CheckIcon from '@mui/icons-material/Check'
import CloseIcon from '@mui/icons-material/Close'
import RemoveIcon from '@mui/icons-material/Remove'
import TuneIcon from '@mui/icons-material/Tune'
import {
  CAMERA_RESOLUTIONS,
  type CameraResolution,
  type CameraRotation
} from '../../../main/Globals'
import ParkingGuides from './ParkingGuides'

type CameraStatus = 'connecting' | 'streaming' | 'error'

type UsbCameraProps = {
  deviceId: string
  rotation: CameraRotation
  resolution: CameraResolution
  horizontalFlip: boolean
  verticalFlip: boolean
  onRotationSave?: (rotation: CameraRotation) => void
  onResolutionSave?: (resolution: CameraResolution) => void
  onHorizontalFlipSave?: (horizontalFlip: boolean) => void
  onVerticalFlipSave?: (verticalFlip: boolean) => void
  onExit?: () => void
  showControls?: boolean
}

/** Browser-native UVC camera surface. Opening getUserMedia powers the selected
 * camera; stopping every media track on unmount releases it. */
export default function UsbCamera({
  deviceId,
  rotation,
  resolution,
  horizontalFlip,
  verticalFlip,
  onRotationSave,
  onResolutionSave,
  onHorizontalFlipSave,
  onVerticalFlipSave,
  onExit,
  showControls = true
}: UsbCameraProps): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rotationRef = useRef(rotation)
  const horizontalFlipRef = useRef(horizontalFlip)
  const verticalFlipRef = useRef(verticalFlip)
  const [calibrating, setCalibrating] = useState(false)
  const [draftRotation, setDraftRotation] = useState(rotation)
  const [draftResolution, setDraftResolution] = useState(resolution)
  const [draftHorizontalFlip, setDraftHorizontalFlip] = useState(horizontalFlip)
  const [draftVerticalFlip, setDraftVerticalFlip] = useState(verticalFlip)
  const [status, setStatus] = useState<CameraStatus>('connecting')
  const [message, setMessage] = useState('Starting USB camera…')
  const [hasFrame, setHasFrame] = useState(false)
  const [fps, setFps] = useState(0)
  const [actualResolution, setActualResolution] = useState('')
  const [cameraLabel, setCameraLabel] = useState('USB camera')

  useEffect(() => {
    if (!calibrating) {
      rotationRef.current = rotation
      setDraftRotation(rotation)
    }
  }, [rotation, calibrating])

  useEffect(() => {
    horizontalFlipRef.current = horizontalFlip
    setDraftHorizontalFlip(horizontalFlip)
  }, [horizontalFlip])

  useEffect(() => {
    verticalFlipRef.current = verticalFlip
    setDraftVerticalFlip(verticalFlip)
  }, [verticalFlip])

  useEffect(() => setDraftResolution(resolution), [resolution])

  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    let animationFrame = 0
    let lastVideoTime = -1
    let frameCount = 0
    let fpsStartedAt = performance.now()
    let firstFrameDrawn = false

    const draw = (): void => {
      if (cancelled) return
      const video = videoRef.current
      const canvas = canvasRef.current

      if (
        video && canvas && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        video.videoWidth > 0 && video.videoHeight > 0 && video.currentTime !== lastVideoTime
      ) {
        lastVideoTime = video.currentTime
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
          const radians = (rotationRef.current * Math.PI) / 180
          const cosine = Math.abs(Math.cos(radians))
          const sine = Math.abs(Math.sin(radians))
          const scale = Math.max(
            (cosine * width + sine * height) / video.videoWidth,
            (sine * width + cosine * height) / video.videoHeight
          )
          const drawWidth = video.videoWidth * scale
          const drawHeight = video.videoHeight * scale

          context.setTransform(1, 0, 0, 1, 0, 0)
          context.fillStyle = '#000'
          context.fillRect(0, 0, width, height)
          context.save()
          context.translate(width / 2, height / 2)
          context.rotate(radians)
          context.scale(
            horizontalFlipRef.current ? -1 : 1,
            verticalFlipRef.current ? -1 : 1
          )
          context.drawImage(video, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight)
          context.restore()

          frameCount += 1
          const now = performance.now()
          if (now - fpsStartedAt >= 1000) {
            setFps(frameCount * 1000 / (now - fpsStartedAt))
            frameCount = 0
            fpsStartedAt = now
          }
          if (!firstFrameDrawn) {
            firstFrameDrawn = true
            setHasFrame(true)
          }
        }
      }
      animationFrame = requestAnimationFrame(draw)
    }

    const start = async (): Promise<void> => {
      setStatus('connecting')
      setMessage('Starting USB camera…')
      setHasFrame(false)
      setFps(0)
      setActualResolution('')
      setCameraLabel('USB camera')

      const selectedResolution = CAMERA_RESOLUTIONS.find(option => option.value === resolution)
        ?? CAMERA_RESOLUTIONS[0]
      const constraints: MediaTrackConstraints = {
        width: { ideal: selectedResolution.width },
        height: { ideal: selectedResolution.height },
        frameRate: { ideal: 30 }
      }
      if (deviceId) constraints.deviceId = { exact: deviceId }

      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false })
        if (cancelled) {
          stream.getTracks().forEach(track => track.stop())
          return
        }

        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        await video.play()

        const track = stream.getVideoTracks()[0]
        const trackSettings = track.getSettings()
        setCameraLabel(track.label || 'USB camera')
        setActualResolution(
          trackSettings.width && trackSettings.height
            ? `${trackSettings.width}×${trackSettings.height}`
            : selectedResolution.label
        )
        setStatus('streaming')
        setMessage(`${track.label || 'USB camera'} is live`)
        animationFrame = requestAnimationFrame(draw)
      } catch (error) {
        if (cancelled) return
        setStatus('error')
        setMessage(cameraErrorMessage(error))
      }
    }

    void start()
    return () => {
      cancelled = true
      cancelAnimationFrame(animationFrame)
      stream?.getTracks().forEach(track => track.stop())
      if (videoRef.current) videoRef.current.srcObject = null
    }
  }, [deviceId, resolution])

  const updateDraftRotation = (value: number): void => {
    const normalized = ((Math.round(value) % 360) + 360) % 360
    rotationRef.current = normalized
    setDraftRotation(normalized)
  }

  const toggleCalibration = (): void => {
    if (calibrating) {
      onRotationSave?.(draftRotation)
      setCalibrating(false)
      return
    }
    updateDraftRotation(rotation)
    setCalibrating(true)
  }

  const changeHorizontalFlip = (next: boolean): void => {
    horizontalFlipRef.current = next
    setDraftHorizontalFlip(next)
    onHorizontalFlipSave?.(next)
  }

  const changeVerticalFlip = (next: boolean): void => {
    verticalFlipRef.current = next
    setDraftVerticalFlip(next)
    onVerticalFlipSave?.(next)
  }

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#000' }}>
      <video ref={videoRef} autoPlay muted playsInline style={{ display: 'none' }} />

      {showControls && (
        <div
          aria-label="USB camera diagnostics"
          style={{
            position: 'absolute', bottom: '5.5%', left: '50%', transform: 'translateX(-50%)',
            zIndex: 8, minWidth: 224, maxWidth: 280, boxSizing: 'border-box',
            padding: '7px 12px 8px', borderRadius: 22, color: '#fff',
            background: 'rgba(0,0,0,0.72)', boxShadow: '0 1px 7px rgba(0,0,0,0.45)',
            textAlign: 'center', fontSize: 11, lineHeight: 1.3, fontWeight: 500,
            fontVariantNumeric: 'tabular-nums', pointerEvents: 'none'
          }}
        >
          <div style={{ whiteSpace: 'nowrap' }}>
            <span style={{ color: status === 'streaming' ? '#62dc78' : '#ffd166' }}>
              ● {status === 'streaming' ? 'LIVE' : status === 'error' ? 'ERR' : 'START'}
            </span>
            <span> · {fps.toFixed(1)} FPS</span>
            {actualResolution && <span> · {actualResolution}</span>}
          </div>
          <div style={{ marginTop: 2, opacity: 0.88, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {cameraLabel}
          </div>
        </div>
      )}

      <div style={showControls ? {
        position: 'absolute', top: '50%', left: '50%', width: '87%', aspectRatio: '16 / 9',
        transform: 'translate(-50%, -50%)', overflow: 'hidden', background: '#000'
      } : { position: 'absolute', inset: 0, overflow: 'hidden', background: '#000' }}>
        <canvas ref={canvasRef} aria-label="USB backup camera" style={{ width: '100%', height: '100%', display: 'block' }} />
        <ParkingGuides />
        {!hasFrame && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', padding: '12%', textAlign: 'center',
            color: '#fff', background: 'rgba(0,0,0,0.72)'
          }}>
            <Typography variant="h6">{status === 'error' ? 'USB Camera Unavailable' : 'USB Camera'}</Typography>
            <Typography variant="body2" sx={{ mt: 1, opacity: 0.8 }}>{message}</Typography>
          </div>
        )}
      </div>

      {showControls && onExit && (
        <IconButton
          aria-label="Exit USB backup camera" title="Exit camera" onClick={onExit}
          sx={{
            position: 'absolute', top: '17%', left: '20%', zIndex: 6, width: 52, height: 52,
            color: '#fff', border: '1px solid rgba(255,255,255,0.65)',
            backgroundColor: 'rgba(0,0,0,0.72)', boxShadow: '0 2px 10px rgba(0,0,0,0.55)',
            '&:hover': { backgroundColor: 'rgba(0,0,0,0.72)' }
          }}
        ><CloseIcon /></IconButton>
      )}

      {showControls && (
        <IconButton
          aria-label={calibrating ? 'Save camera adjustments' : 'Adjust camera image'}
          title={calibrating ? 'Save camera adjustments' : 'Adjust camera image'}
          onClick={toggleCalibration}
          sx={{
            position: 'absolute', top: '13%', left: '50%', transform: 'translateX(-50%)',
            zIndex: 6, width: 52, height: 52, color: '#fff',
            border: '1px solid rgba(255,255,255,0.55)',
            backgroundColor: calibrating ? 'rgba(38,122,70,0.9)' : 'rgba(0,0,0,0.68)',
            boxShadow: '0 2px 10px rgba(0,0,0,0.55)'
          }}
        >{calibrating ? <CheckIcon /> : <TuneIcon />}</IconButton>
      )}

      {showControls && calibrating && (
        <div style={{
          position: 'absolute', top: '25%', left: '50%', transform: 'translateX(-50%)',
          zIndex: 5, width: '78%', padding: '12px 22px 10px', borderRadius: 14,
          color: '#fff', background: 'rgba(0,0,0,0.72)', boxShadow: '0 3px 14px rgba(0,0,0,0.5)'
        }}>
          <Typography variant="subtitle2" align="center">Rotation {draftRotation}°</Typography>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <IconButton
              aria-label="Rotate camera one degree counter-clockwise"
              onClick={() => updateDraftRotation(draftRotation - 1)}
              sx={{ width: 48, height: 48, color: '#fff', border: '1px solid rgba(255,255,255,0.5)' }}
            ><RemoveIcon /></IconButton>
            <Slider
              aria-label="USB camera rotation" value={draftRotation} min={0} max={359} step={1}
              marks={[0, 90, 180, 270, 359].map(value => ({ value, label: `${value}°` }))}
              valueLabelDisplay="auto" valueLabelFormat={value => `${value}°`}
              onChange={(_, value) => typeof value === 'number' && updateDraftRotation(value)}
              sx={{ minWidth: 0, color: '#e6e3db', '& .MuiSlider-markLabel': { color: 'rgba(255,255,255,0.78)' } }}
            />
            <IconButton
              aria-label="Rotate camera one degree clockwise"
              onClick={() => updateDraftRotation(draftRotation + 1)}
              sx={{ width: 48, height: 48, color: '#fff', border: '1px solid rgba(255,255,255,0.5)' }}
            ><AddIcon /></IconButton>
          </div>
          <Stack direction="row" spacing={2} alignItems="center" justifyContent="center" sx={{ mt: 1 }}>
            <FormControl size="small" sx={{ minWidth: 170 }}>
              <Select
                aria-label="USB camera resolution" value={draftResolution}
                onChange={event => {
                  const next = event.target.value as CameraResolution
                  setDraftResolution(next)
                  onResolutionSave?.(next)
                }}
                sx={{
                  color: '#fff', backgroundColor: 'rgba(255,255,255,0.1)',
                  '& .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(255,255,255,0.45)' },
                  '& .MuiSvgIcon-root': { color: '#fff' }
                }}
              >
                {CAMERA_RESOLUTIONS.map(option => (
                  <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControlLabel
              control={<Switch checked={draftHorizontalFlip} onChange={(_, checked) => changeHorizontalFlip(checked)} />}
              label="Horizontal flip" sx={{ mx: 0 }}
            />
            <FormControlLabel
              control={<Switch checked={draftVerticalFlip} onChange={(_, checked) => changeVerticalFlip(checked)} />}
              label="Vertical flip" sx={{ mx: 0 }}
            />
          </Stack>
          <Typography variant="caption" display="block" align="center" sx={{ opacity: 0.72 }}>
            Flip and rotation changes apply live. Resolution changes restart the USB stream.
          </Typography>
          <Typography
            variant="caption" display="block" align="center"
            color={status === 'error' ? '#ff9a9a' : 'inherit'} sx={{ mt: 0.5, opacity: 0.82 }}
          >{message}</Typography>
        </div>
      )}
    </div>
  )
}

function cameraErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return 'Camera permission was denied.'
    if (error.name === 'NotFoundError') return 'The selected USB camera is not connected.'
    if (error.name === 'NotReadableError') return 'The USB camera is in use by another application.'
    if (error.name === 'OverconstrainedError') return 'The selected camera mode is not supported.'
  }
  return error instanceof Error ? error.message : 'Could not start the USB camera.'
}
