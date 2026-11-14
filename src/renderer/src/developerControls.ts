export type DeveloperControls = { enabled: boolean; showMousePointer: boolean }
const key = 'round-carplay-developer-controls'
let refreshTimers: ReturnType<typeof setTimeout>[] = []
let focusListenersInstalled = false

function refreshCursorFocus(): void {
  for (const timer of refreshTimers) clearTimeout(timer)
  const refresh = () => {
    if (typeof fetch === 'function') {
      void fetch('/api/developer/pointer-refresh', { method: 'POST' }).catch(() => undefined)
    }
  }
  refresh()
  // Cage can acquire pointer focus before Chromium has applied the page's
  // cursor rule. Retry after page startup, without continuous mouse motion.
  refreshTimers = [250, 1000, 3000, 10000].map(delay => setTimeout(refresh, delay))
}

export function readDeveloperControls(): DeveloperControls {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}')
    return { enabled: value.enabled === true, showMousePointer: value.enabled === true && value.showMousePointer === true }
  } catch { return { enabled: false, showMousePointer: false } }
}

export function applyDeveloperControls(value = readDeveloperControls()): void {
  let style = document.getElementById('pi-hide-cursor') as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = 'pi-hide-cursor'
    document.head.appendChild(style)
  }
  style.textContent = value.enabled && value.showMousePointer ? '' :
    'html,body,body *,body *::before,body *::after{cursor:none!important}'
  if (!focusListenersInstalled && typeof window !== 'undefined') {
    focusListenersInstalled = true
    window.addEventListener('load', refreshCursorFocus)
    window.addEventListener('pageshow', refreshCursorFocus)
    window.addEventListener('focus', refreshCursorFocus)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refreshCursorFocus()
    })
  }
  refreshCursorFocus()
}

export function saveDeveloperControls(value: DeveloperControls): void {
  const normalized = { enabled: value.enabled, showMousePointer: value.enabled && value.showMousePointer }
  try { localStorage.setItem(key, JSON.stringify(normalized)) } catch { /* Apply for this session if storage is unavailable. */ }
  applyDeveloperControls(normalized)
}
