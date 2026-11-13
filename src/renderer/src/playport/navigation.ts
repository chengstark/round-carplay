import type { NavigationViewState } from './protocol'

export type NavigationApp = 'apple-maps' | 'google-maps' | 'unknown'

export function navigationApp(source?: string): NavigationApp {
  const name = source?.trim().toLowerCase() || ''
  if (/google.*maps|maps.*google/.test(name)) return 'google-maps'
  if (name === 'apple maps' || name === 'maps') return 'apple-maps'
  return 'unknown'
}

export function remainingTrip(seconds?: number): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`
}

export function arrivalTime(epochSeconds?: number): string | null {
  if (epochSeconds == null || !Number.isFinite(epochSeconds) || epochSeconds < 946684800) return null
  const date = new Date(epochSeconds * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function tripDistance(navigation: NavigationViewState): string | null {
  const text = navigation.distanceRemainingText?.trim()
  const unit = ['km', 'mi', 'm', 'yd', 'ft'][navigation.distanceRemainingUnit ?? -1]
  if (text && /[a-z]/i.test(text)) return text
  if (text && unit) return `${text} ${unit}`
  const meters = navigation.distanceRemainingMeters
  if (meters == null || !Number.isFinite(meters) || meters < 0) return null
  if (navigation.distanceRemainingUnit === 1) return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(meters / 1609.344)} mi`
  return meters < 1000 ? `${Math.round(meters)} m` : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(meters / 1000)} km`
}
