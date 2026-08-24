import { useCallback, useEffect, useState } from 'react'
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  TextField,
  Typography
} from '@mui/material'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import CloseIcon from '@mui/icons-material/Close'
import LockIcon from '@mui/icons-material/Lock'
import RefreshIcon from '@mui/icons-material/Refresh'
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt'
import WifiIcon from '@mui/icons-material/Wifi'
import type { IpAddress, WifiNetwork } from '../../../main/network/NetworkService'
import type { SystemUpdateStatus } from '../../../main/update/SystemUpdateService'

const BACKGROUND_PRESETS = ['#000000', '#1b1f23', '#17324d', '#556b5f', '#a0bacc', '#8b7355']

type SystemMenuProps = {
  backgroundColor: string
  onBackgroundColorChange: (color: string) => void
  onClose: () => void
}

export default function SystemMenu({
  backgroundColor,
  onBackgroundColorChange,
  onClose
}: SystemMenuProps): React.JSX.Element {
  const [networks, setNetworks] = useState<WifiNetwork[]>([])
  const [ipAddresses, setIpAddresses] = useState<IpAddress[]>([])
  const [selectedNetwork, setSelectedNetwork] = useState<WifiNetwork | null>(null)
  const [password, setPassword] = useState('')
  const [scanning, setScanning] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [message, setMessage] = useState('')
  const [updateStatus, setUpdateStatus] = useState<SystemUpdateStatus>({
    state: 'idle',
    message: 'Check for application updates'
  })

  const refreshNetworks = useCallback(async (): Promise<void> => {
    setScanning(true)
    try {
      const snapshot = await window.carplay.network.scanWifi()
      setNetworks(snapshot.networks)
      setIpAddresses(snapshot.ipAddresses)
      setMessage(snapshot.error ?? '')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setScanning(false)
    }
  }, [])

  useEffect(() => {
    refreshNetworks()
  }, [refreshNetworks])

  useEffect(() => {
    let active = true
    const removeUpdateListener = window.carplay.update.onStatus(status => {
      if (active) setUpdateStatus(status)
    })

    window.carplay.update.getStatus()
      .then(status => {
        if (active) setUpdateStatus(status)
      })
      .catch(error => {
        if (active) {
          setUpdateStatus({
            state: 'error',
            message: error instanceof Error ? error.message : String(error)
          })
        }
      })

    return () => {
      active = false
      removeUpdateListener()
    }
  }, [])

  const selectNetwork = (network: WifiNetwork): void => {
    setSelectedNetwork(network)
    setPassword('')
    setMessage(network.connected ? `Connected to ${network.ssid}` : '')
  }

  const connect = async (): Promise<void> => {
    if (!selectedNetwork) return
    setConnecting(true)
    setMessage(`Connecting to ${selectedNetwork.ssid}…`)
    try {
      const result = await window.carplay.network.connectWifi(selectedNetwork.ssid, password)
      setIpAddresses(result.ipAddresses)
      setMessage(result.message)
      if (result.ok) {
        setPassword('')
        await refreshNetworks()
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setConnecting(false)
    }
  }

  const startUpdate = async (): Promise<void> => {
    setUpdateStatus({ state: 'pulling', message: 'Starting update…' })
    try {
      setUpdateStatus(await window.carplay.update.start())
    } catch (error) {
      setUpdateStatus({
        state: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const updating = updateStatus.state === 'pulling' || updateStatus.state === 'building'
  const updateColor = updateStatus.state === 'success'
    ? '#69d58b'
    : updateStatus.state === 'error'
      ? '#ff8585'
      : updateStatus.state === 'no-update'
        ? '#8fc7ff'
        : 'rgba(255,255,255,0.72)'

  const currentIp = ipAddresses.length
    ? ipAddresses.map(item => `${item.interface}: ${item.address}`).join('  ·  ')
    : 'No IPv4 address'

  return (
    <Box
      sx={{
        position: 'absolute',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        p: 1.5,
        color: '#fff',
        background: 'linear-gradient(155deg, #171a1e 0%, #08090a 75%)'
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', minHeight: 38 }}>
        <Typography variant="h6" sx={{ flexGrow: 1, fontWeight: 600 }}>
          System Menu
        </Typography>
        <IconButton aria-label="Close system menu" onClick={onClose} sx={{ color: '#fff' }}>
          <CloseIcon />
        </IconButton>
      </Box>

      <Typography variant="caption" sx={{ opacity: 0.72, mb: 0.5 }}>
        Surround background
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8, mb: 1 }}>
        {BACKGROUND_PRESETS.map(color => (
          <button
            key={color}
            type="button"
            aria-label={`Set background to ${color}`}
            onClick={() => onBackgroundColorChange(color)}
            style={{
              width: 28,
              height: 28,
              flex: '0 0 auto',
              padding: 0,
              borderRadius: '50%',
              border: color.toLowerCase() === backgroundColor.toLowerCase()
                ? '3px solid #fff'
                : '1px solid rgba(255,255,255,0.5)',
              backgroundColor: color,
              boxShadow: '0 1px 4px rgba(0,0,0,0.65)'
            }}
          />
        ))}
        <label
          title="Custom background color"
          style={{
            width: 30,
            height: 30,
            flex: '0 0 auto',
            overflow: 'hidden',
            borderRadius: '50%',
            border: '1px solid rgba(255,255,255,0.65)'
          }}
        >
          <input
            aria-label="Custom background color"
            type="color"
            value={backgroundColor}
            onChange={event => onBackgroundColorChange(event.target.value)}
            style={{ width: 42, height: 42, margin: -6, padding: 0, border: 0 }}
          />
        </label>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', minHeight: 32 }}>
        <WifiIcon fontSize="small" sx={{ mr: 0.7 }} />
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          Wi-Fi networks
        </Typography>
        <IconButton
          aria-label="Refresh Wi-Fi networks"
          onClick={refreshNetworks}
          disabled={scanning || connecting}
          size="small"
          sx={{ color: '#fff' }}
        >
          {scanning ? <CircularProgress size={18} color="inherit" /> : <RefreshIcon fontSize="small" />}
        </IconButton>
      </Box>

      <Box
        sx={{
          minHeight: 65,
          flex: '1 1 auto',
          overflowY: 'auto',
          borderRadius: 1,
          backgroundColor: 'rgba(255,255,255,0.055)'
        }}
      >
        {!scanning && networks.length === 0 && (
          <Typography variant="caption" sx={{ display: 'block', p: 1.2, opacity: 0.7 }}>
            No Wi-Fi networks found
          </Typography>
        )}
        {networks.map(network => {
          const selected = selectedNetwork?.ssid === network.ssid
          return (
            <button
              key={network.ssid}
              type="button"
              onClick={() => selectNetwork(network)}
              style={{
                width: '100%',
                minHeight: 38,
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                padding: '6px 9px',
                border: 0,
                borderBottom: '1px solid rgba(255,255,255,0.07)',
                color: '#fff',
                textAlign: 'left',
                background: selected ? 'rgba(255,255,255,0.16)' : 'transparent'
              }}
            >
              {network.connected ? (
                <CheckCircleIcon sx={{ fontSize: 17, color: '#69d58b' }} />
              ) : (
                <WifiIcon sx={{ fontSize: 17, opacity: Math.max(0.35, network.signal / 100) }} />
              )}
              <span
                style={{
                  flex: '1 1 auto',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: 13
                }}
              >
                {network.ssid}
              </span>
              {network.security && <LockIcon sx={{ fontSize: 13, opacity: 0.65 }} />}
              <span style={{ minWidth: 32, fontSize: 11, opacity: 0.68 }}>{network.signal}%</span>
            </button>
          )
        })}
      </Box>

      {selectedNetwork && !selectedNetwork.connected && (
        <Box sx={{ display: 'flex', gap: 0.8, mt: 0.8 }}>
          {selectedNetwork.security && (
            <TextField
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              placeholder="Wi-Fi password"
              size="small"
              fullWidth
              autoComplete="new-password"
              sx={{
                '& .MuiInputBase-root': { height: 34, color: '#fff', fontSize: 12 },
                '& fieldset': { borderColor: 'rgba(255,255,255,0.28)' }
              }}
            />
          )}
          <Button
            variant="contained"
            size="small"
            disabled={connecting}
            onClick={connect}
            sx={{ minWidth: 82, height: 34 }}
          >
            {connecting ? <CircularProgress size={17} color="inherit" /> : 'Connect'}
          </Button>
        </Box>
      )}

      {message && (
        <Typography
          variant="caption"
          sx={{ mt: 0.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={message}
        >
          {message}
        </Typography>
      )}

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          flex: '0 0 auto',
          mt: 0.7,
          pt: 0.7,
          borderTop: '1px solid rgba(255,255,255,0.12)'
        }}
      >
        <Button
          variant="outlined"
          size="small"
          disabled={updating}
          onClick={startUpdate}
          startIcon={
            updating
              ? <CircularProgress size={15} color="inherit" />
              : <SystemUpdateAltIcon fontSize="small" />
          }
          sx={{
            flex: '0 0 auto',
            minWidth: 96,
            height: 32,
            color: '#fff',
            borderColor: 'rgba(255,255,255,0.4)'
          }}
        >
          {updateStatus.state === 'pulling'
            ? 'Pulling'
            : updateStatus.state === 'building'
              ? 'Building'
              : 'Update'}
        </Button>
        <Typography
          variant="caption"
          title={updateStatus.message}
          sx={{
            flex: '1 1 auto',
            maxHeight: 34,
            overflow: 'hidden',
            color: updateColor,
            lineHeight: 1.2
          }}
        >
          {updateStatus.message}
        </Typography>
      </Box>

      <Typography
        variant="caption"
        title={currentIp}
        sx={{
          flex: '0 0 auto',
          mt: 0.6,
          pt: 0.5,
          overflow: 'hidden',
          color: 'rgba(255,255,255,0.72)',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          borderTop: '1px solid rgba(255,255,255,0.12)'
        }}
      >
        IP · {currentIp}
      </Typography>
    </Box>
  )
}
