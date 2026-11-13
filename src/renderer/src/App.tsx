import { useEffect, useState, type ReactNode } from 'react'
import AccessTimeRoundedIcon from '@mui/icons-material/AccessTimeRounded'
import CameraAltRoundedIcon from '@mui/icons-material/CameraAltRounded'
import MusicNoteRoundedIcon from '@mui/icons-material/MusicNoteRounded'
import PhoneRoundedIcon from '@mui/icons-material/PhoneRounded'
import SettingsRoundedIcon from '@mui/icons-material/SettingsRounded'
import Camera from './components/Camera'
import PlayPortSurface, { type PlayPortView } from './components/PlayPortSurface'
import PorscheClock from './components/clock/PorscheClock'
import SystemMenu from './components/SystemMenu'
import { useCarplayStore, useStatusStore } from './store/store'
import { updateCameras } from './utils/cameraDetection'
import { EMPTY_SPEED, type SpeedReading } from '../../shared/speedOcr'
import './Dashboard.css'

const DEFAULT_BACKGROUND = '#000000'

export default function App(): React.JSX.Element {
  const settings = useCarplayStore((state) => state.settings)
  const saveSettings = useCarplayStore((state) => state.saveSettings)
  const setCameraFound = useStatusStore((state) => state.setCameraFound)
  const reverse = useStatusStore((state) => state.reverse)
  const [time, setTime] = useState(new Date())
  const [view, setView] = useState<PlayPortView>('map')
  const [clockOpen, setClockOpen] = useState(false)
  const [cameraOpen, setCameraOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mapControlsOpen, setMapControlsOpen] = useState(false)
  const [ocrSpeed, setOcrSpeed] = useState<SpeedReading>({ ...EMPTY_SPEED })

  const backgroundColor = DEFAULT_BACKGROUND
  const cameraVisible = cameraOpen || reverse
  const mapVisible = view === 'map' && !cameraVisible && !clockOpen && !settingsOpen
  const speedMph = ocrSpeed.current == null ? null :
    ocrSpeed.unit === 'km/h' ? ocrSpeed.current / 1.609344 : ocrSpeed.current

  useEffect(() => {
    if (!mapVisible) setMapControlsOpen(false)
  }, [mapVisible])

  useEffect(() => {
    const timer = window.setInterval(() => setTime(new Date()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!settings) return
    updateCameras(setCameraFound, saveSettings, settings)
  }, [saveSettings, setCameraFound, settings])

  const selectView = (next: Exclude<PlayPortView, 'map'>) => {
    setClockOpen(false)
    setCameraOpen(false)
    setView((current) => current === next ? 'map' : next)
  }

  return (
    <div className="dashboard-page" style={{ backgroundColor }}>
      <section className="round-dashboard" style={{ backgroundColor }}>
        <PlayPortSurface view={view} onSpeed={setOcrSpeed} />

        {!settingsOpen && !cameraVisible && !clockOpen && (
          <header className="top-hud" aria-label="Time and speed">
            <time>{time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
            <span className="top-hud-divider" aria-hidden="true" />
            <span className="speed-value">
              {speedMph != null ? Math.round(speedMph) : '--'}
              <small>MPH</small>
            </span>
          </header>
        )}

        {clockOpen && (
          <div className="dashboard-overlay clock-overlay">
            <PorscheClock variant="full" onExit={() => setClockOpen(false)} />
          </div>
        )}

        {cameraVisible && (
          <div className="dashboard-overlay camera-overlay">
            <Camera settings={settings} />
          </div>
        )}

        {settingsOpen && (
          <div className="dashboard-overlay settings-overlay">
            <SystemMenu
              gpsSmoothing={settings?.gpsSmoothing ?? 0.55}
              onGpsSmoothingChange={(gpsSmoothing) => {
                if (settings) saveSettings({ ...settings, gpsSmoothing })
              }}
              onClose={() => setSettingsOpen(false)}
            />
          </div>
        )}

        {mapVisible && (
          <button
            type="button"
            className="dock-toggle"
            aria-label={mapControlsOpen ? 'Hide dashboard controls' : 'Show dashboard controls'}
            aria-expanded={mapControlsOpen}
            aria-controls="dashboard-controls"
            onClick={() => setMapControlsOpen(open => !open)}
          />
        )}

        {!settingsOpen && !reverse && !clockOpen && (
          <nav id="dashboard-controls" className="dashboard-dock" aria-label="Dashboard controls"
            data-map={view === 'map' && !cameraOpen} hidden={mapVisible && !mapControlsOpen}>
            <DockButton
              label="Clock"
              active={clockOpen}
              onClick={() => {
                setCameraOpen(false)
                setClockOpen((open) => !open)
              }}
              icon={<AccessTimeRoundedIcon />}
            />
            <DockButton
              label="Media"
              active={!clockOpen && !cameraOpen && view === 'media'}
              onClick={() => selectView('media')}
              icon={<MusicNoteRoundedIcon />}
            />
            <DockButton
              label="Phone"
              active={!clockOpen && !cameraOpen && view === 'phone'}
              onClick={() => selectView('phone')}
              icon={<PhoneRoundedIcon />}
            />
            <DockButton
              label="Camera"
              active={cameraOpen}
              onClick={() => {
                setClockOpen(false)
                setCameraOpen((open) => !open)
              }}
              icon={<CameraAltRoundedIcon />}
            />
            <DockButton
              label="Settings"
              active={false}
              onClick={() => setSettingsOpen(true)}
              icon={<SettingsRoundedIcon />}
            />
          </nav>
        )}
      </section>
    </div>
  )
}

function DockButton({
  label,
  active,
  onClick,
  icon
}: {
  label: string
  active: boolean
  onClick(): void
  icon: ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="dock-button"
      data-active={active}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}
