import { useCallback, useEffect, useRef, useState } from 'react'
import BrightnessControls from './BrightnessControls'
import type { IpAddress, WifiNetwork } from '../../../main/network/NetworkService'
import type { SystemUpdateStatus } from '../../../main/update/SystemUpdateService'
import './SystemMenu.css'

type Page = 'home' | 'wifi' | 'gps' | 'system'
type Props = {
  gpsSmoothing: number
  onGpsSmoothingChange(value: number): void
  onClose(): void
}
const titles: Record<Page, string> = { home: 'Settings', wifi: 'Wi-Fi', gps: 'Speed display', system: 'System' }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export function SettingsIcon({ name }: { name: 'back' | 'wifi' | 'gps' | 'system' | 'next' }): React.JSX.Element {
  const paths = {
    back: 'M15 5l-7 7 7 7',
    next: 'M9 5l7 7-7 7',
    wifi: 'M3 9a15 15 0 0 1 18 0M6 13a10 10 0 0 1 12 0M9 17a5 5 0 0 1 6 0M12 21h.01',
    gps: 'M4 17a9 9 0 1 1 16 0M12 13l5-5M5 20h14M12 13h.01',
    system: 'M12 3v8M6 5a9 9 0 1 0 12 0'
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>
}

export default function SystemMenu({ gpsSmoothing, onGpsSmoothingChange, onClose }: Props): React.JSX.Element {
  const [page, setPage] = useState<Page>('home')
  const dialog = useRef<HTMLElement>(null)
  const [networks, setNetworks] = useState<WifiNetwork[]>([])
  const [addresses, setAddresses] = useState<IpAddress[]>([])
  const [available, setAvailable] = useState<boolean | null>(null)
  const [selected, setSelected] = useState<WifiNetwork | null>(null)
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [message, setMessage] = useState('')
  const [smoothing, setSmoothing] = useState(gpsSmoothing)
  const [update, setUpdate] = useState<SystemUpdateStatus>({ state: 'idle', message: 'Your dashboard software' })
  const [confirmReboot, setConfirmReboot] = useState(false)
  const [rebooting, setRebooting] = useState(false)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLButtonElement>('.settings-back')?.focus()
    return () => previous?.focus()
  }, [])

  useEffect(() => setSmoothing(gpsSmoothing), [gpsSmoothing])
  useEffect(() => {
    let active = true
    const remove = window.carplay.update.onStatus(value => { if (active) setUpdate(value) })
    void window.carplay.update.getStatus().then(value => { if (active) setUpdate(value) }).catch(error => {
      if (active) setUpdate({ state: 'error', message: errorText(error) })
    })
    void window.carplay.network.getIpAddresses().then(value => { if (active) setAddresses(value) }).catch(() => undefined)
    return () => { active = false; remove() }
  }, [])

  const scan = useCallback(async () => {
    setScanning(true)
    try {
      const value = await window.carplay.network.scanWifi()
      setAvailable(value.available)
      setNetworks(value.networks)
      setAddresses(value.ipAddresses)
      setMessage(value.error || (value.available ? '' : 'Wi-Fi is unavailable. Try scanning again.'))
    } catch (error) { setMessage(errorText(error)) }
    finally { setScanning(false) }
  }, [])
  useEffect(() => { if (page === 'wifi') void scan() }, [page, scan])

  const back = () => {
    if (confirmReboot) setConfirmReboot(false)
    else if (selected) { setSelected(null); setPassword(''); setShowPassword(false); setMessage('') }
    else if (page === 'home') onClose()
    else { setPage('home'); setMessage('') }
  }
  const changeSmoothing = (value: number) => {
    const next = Math.round(Math.max(0, Math.min(0.9, value)) * 100) / 100
    setSmoothing(next)
    onGpsSmoothingChange(next)
  }
  const connect = async () => {
    if (!selected || connecting) return
    setConnecting(true)
    setMessage('Connecting…')
    try {
      const result = await window.carplay.network.connectWifi(selected.ssid, password)
      setMessage(result.message)
      setAddresses(result.ipAddresses)
      if (result.ok) { setSelected(null); setPassword(''); void scan() }
    } catch (error) { setMessage(errorText(error)) }
    finally { setConnecting(false) }
  }
  const updateSoftware = async () => {
    setUpdate({ state: 'pulling', message: 'Checking and updating…' })
    try { setUpdate(await window.carplay.update.start()) }
    catch (error) { setUpdate({ state: 'error', message: errorText(error) }) }
  }
  const reboot = async () => {
    setRebooting(true)
    try {
      const result = await window.carplay.update.reboot()
      if (!result.ok) { setUpdate({ state: 'error', message: result.message }); setRebooting(false); setConfirmReboot(false) }
    } catch (error) { setUpdate({ state: 'error', message: errorText(error) }); setRebooting(false); setConfirmReboot(false) }
  }
  const updating = ['pulling', 'building', 'installing'].includes(update.state)
  useEffect(() => {
    if (!updating) return
    const timer = window.setInterval(() => {
      void window.carplay.update.getStatus().then(setUpdate).catch(() => undefined)
    }, 3_000)
    return () => window.clearInterval(timer)
  }, [updating])

  return (
    <section ref={dialog} className="round-settings" role="dialog" aria-modal="true" aria-label="Settings" onKeyDown={event => {
      if (event.key === 'Escape' && !connecting && !rebooting) { event.preventDefault(); back() }
      if (event.key !== 'Tab') return
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') || [])
      const first = controls[0], last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }}>
      <header className="settings-header">
        <button type="button" className="settings-back" onClick={back} aria-label={page === 'home' ? 'Close settings' : 'Back'} disabled={connecting || rebooting}>
          <SettingsIcon name="back" />
        </button>
        <h1>{titles[page]}</h1>
        <span className="settings-header-balance" aria-hidden="true" />
      </header>

      <div className={`settings-body ${page === 'home' ? 'settings-home' : ''}`} key={page + (selected?.ssid || '')} tabIndex={-1}>
        {page === 'home' && <>
          <BrightnessControls />
          <nav className="settings-categories" aria-label="Settings sections">
            {([
              { id: 'wifi', label: 'Wi-Fi', detail: 'Network connection', icon: 'wifi' },
              { id: 'gps', label: 'Speed display', detail: 'Response & smoothing', icon: 'gps' },
              { id: 'system', label: 'System', detail: 'Updates & device info', icon: 'system' }
            ] as const).map(item => (
              <button type="button" className="settings-category" key={item.id} onClick={() => setPage(item.id)}>
                <SettingsIcon name={item.icon} />
                <span><strong>{item.label}</strong><small>{item.detail}</small></span>
                <SettingsIcon name="next" />
              </button>
            ))}
          </nav>
        </>}

        {page === 'wifi' && <>
          {selected ? <>
            <p className="settings-eyebrow">JOIN NETWORK</p>
            <h2 className="settings-network-title">{selected.ssid}</h2>
            {selected.security && <label className="settings-field">
              <span>{selected.saved ? 'New password (optional)' : 'Password'}</span>
              <input type={showPassword ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" disabled={connecting} />
            </label>}
            {selected.security && <button type="button" className="settings-action settings-secondary" onClick={() => setShowPassword(value => !value)} aria-pressed={showPassword}>{showPassword ? 'Hide password' : 'Show password'}</button>}
            <p className="settings-note">CarPlay reconnects after switching networks. {selected.saved && 'Leave the password blank to use the saved connection.'}</p>
            <button type="button" className="settings-action settings-primary" disabled={connecting || Boolean(selected.security && !selected.saved && !password)} onClick={() => void connect()}>{connecting ? 'Connecting…' : selected.saved ? 'Connect' : 'Join network'}</button>
          </> : <>
            <div className="settings-page-intro"><p>{available === false ? 'Network connection' : 'Choose your network'}</p>{available !== false && <button type="button" className="settings-action settings-secondary" disabled={scanning} onClick={() => void scan()}>{scanning ? 'Scanning…' : 'Scan again'}</button>}</div>
            <div className="settings-network-list">
              {networks.map(network => <button type="button" className="settings-category" key={network.ssid} onClick={() => {
                setSelected(network); setPassword(''); setMessage(''); setShowPassword(false)
              }} aria-label={`${network.ssid}${network.connected ? ', connected' : ''}`}>
                <SettingsIcon name="wifi" />
                <span><strong>{network.ssid}</strong><small>{network.connected ? 'Connected' : `${network.saved ? 'Saved' : network.security ? 'Secured' : 'Open'} · ${network.signal}% signal`}</small></span>
                {network.connected ? <span className="settings-connected-dot" aria-label="Connected" /> : <SettingsIcon name="next" />}
              </button>)}
            </div>
            {!scanning && !networks.length && available !== false && <p className="settings-note">No networks found. Try scanning again.</p>}
          </>}
          {message && <p className="settings-note" role="status">{message}</p>}
        </>}

        {page === 'gps' && <>
          <p className="settings-description">Choose how quickly your speed readout responds.</p>
          <div className="settings-presets">
            {([{ label: 'Responsive', value: 0.25 }, { label: 'Balanced', value: 0.55 }, { label: 'Smooth', value: 0.8 }]).map(preset => (
              <button type="button" className="settings-action settings-preset" key={preset.label} aria-pressed={Math.abs(smoothing - preset.value) < 0.001} onClick={() => changeSmoothing(preset.value)}>{preset.label}</button>
            ))}
          </div>
          <div className="settings-stepper" aria-label="GPS smoothing">
            <button type="button" aria-label="Reduce GPS smoothing" disabled={smoothing <= 0} onClick={() => changeSmoothing(smoothing - 0.05)}>−</button>
            <output aria-live="polite">{Math.round(smoothing * 100)}<small>%</small></output>
            <button type="button" aria-label="Increase GPS smoothing" disabled={smoothing >= 0.9} onClick={() => changeSmoothing(smoothing + 0.05)}>+</button>
          </div>
          <p className="settings-note">Less smoothing reacts faster. More smoothing steadies the readout.</p>
        </>}

        {page === 'system' && <>
          {confirmReboot ? <div className="settings-confirm">
            <h2>Restart dashboard?</h2>
            <p className="settings-description">CarPlay and the camera will disconnect briefly.</p>
            <button type="button" className="settings-action settings-primary" onClick={() => void reboot()} disabled={rebooting}>{rebooting ? 'Restarting…' : 'Restart now'}</button>
            <button type="button" className="settings-action settings-secondary" onClick={() => setConfirmReboot(false)} disabled={rebooting}>Cancel</button>
          </div> : <>
            <p className="settings-eyebrow">DASHBOARD SOFTWARE</p>
            <p className="settings-note">Updates download over Wi-Fi. Installing briefly disconnects CarPlay. Automatic updates wait until CarPlay is idle.</p>
            <p className="settings-note" role="status" data-error={update.state === 'error'}>{update.message}</p>
            <button type="button" className="settings-action settings-primary" disabled={updating} onClick={() => void updateSoftware()}>{updating ? 'Updating…' : 'Check for updates'}</button>
            {update.state === 'success' && <button type="button" className="settings-action settings-secondary" onClick={() => setConfirmReboot(true)}>Restart to finish</button>}
            <div className="settings-device-info">
              <p className="settings-eyebrow">CONNECTION DETAILS</p>
              {addresses.length ? addresses.map(item => <p key={item.interface + item.address}><span>{item.interface}</span><span>{item.address}</span></p>) : <p>No network address</p>}
            </div>
          </>}
        </>}
      </div>
    </section>
  )
}
