import { useEffect } from 'react'
import { Typography, Box, useTheme } from '@mui/material'
import { useCarplayStore, useStatusStore } from '../store/store'

export default function Info() {
  const theme = useTheme()

  // Trigger
  const isDongleConnected = useStatusStore(s => s.isDongleConnected)

  // Core settings & dongle info
  const negotiatedWidth  = useCarplayStore(s => s.negotiatedWidth)
  const negotiatedHeight = useCarplayStore(s => s.negotiatedHeight)
  const serial           = useCarplayStore(s => s.serial)
  const manufacturer     = useCarplayStore(s => s.manufacturer)
  const product          = useCarplayStore(s => s.product)
  const fwVersion        = useCarplayStore(s => s.fwVersion)

  // Connection status
  const isStreaming = useStatusStore(s => s.isStreaming)

  const highlight = (val: any) =>
    val != null ? theme.palette.primary.main : theme.palette.text.primary

  useEffect(() => {
    if (isDongleConnected) {
      window.carplay.usb.getDeviceInfo().then(info => {
       if (info.device) {
          useCarplayStore.setState({
            serial: info.serialNumber,
            manufacturer: info.manufacturerName,
            product: info.productName,
            fwVersion: info.fwVersion,
          })
        }
      })
    } else {
      useCarplayStore.getState().resetInfo()
    }
  }, [isDongleConnected])

  return (
    <Box p={2}>
      <Box display="flex" flexWrap="wrap" gap={2}>
        {/* Hardware Info */}
        <Box sx={{ flex: '1 1 40%', minWidth: 160 }}>
          <Typography variant="h6" gutterBottom>
            Hardware Info
          </Typography>
          <Typography>
            <strong>Serial:</strong>{' '}
            <Box component="span" color={highlight(serial)}>
              {serial || '—'}
            </Box>
          </Typography>
          <Typography>
            <strong>Manufacturer:</strong>{' '}
            <Box component="span" color={highlight(manufacturer)}>
              {manufacturer || '—'}
            </Box>
          </Typography>
          <Typography>
            <strong>Product:</strong>{' '}
            <Box component="span" color={highlight(product)}>
              {product || '—'}
            </Box>
          </Typography>
          <Typography>
            <strong>Firmware:</strong>{' '}
            <Box component="span" color={highlight(fwVersion)}>
              {fwVersion || '—'}
            </Box>
          </Typography>
        </Box>

        {/* Video Info */}
        <Box sx={{ flex: '1 1 20%', minWidth: 100 }}>
          <Typography variant="h6" gutterBottom>
            Video Info
          </Typography>
          <Typography>
            <strong>Resolution:</strong>{' '}
            {negotiatedWidth && negotiatedHeight ? (
              <Box component="span" color={theme.palette.primary.main}>
                {negotiatedWidth}×{negotiatedHeight}
              </Box>
            ) : (
              <Box component="span" color={theme.palette.text.secondary}>
                —
              </Box>
            )}
          </Typography>
        </Box>

        {/* Phone Info */}
        <Box sx={{ flex: '1 1 20%', minWidth: 100 }}>
          <Typography variant="h6" gutterBottom>
            Phone
          </Typography>
          <Typography>
            <strong>Connected:</strong>{' '}
            <Box
              component="span"
              color={
                isStreaming
                  ? theme.palette.success.main
                  : theme.palette.text.primary
              }
            >
              {isStreaming ? 'Yes' : 'No'}
            </Box>
          </Typography>
        </Box>

      </Box>
    </Box>
  )
}
