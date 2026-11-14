export type DeveloperControls = { enabled: boolean; showMousePointer: boolean }
const key = 'round-carplay-developer-controls'

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
}

export function saveDeveloperControls(value: DeveloperControls): void {
  const normalized = { enabled: value.enabled, showMousePointer: value.enabled && value.showMousePointer }
  try { localStorage.setItem(key, JSON.stringify(normalized)) } catch { /* Apply for this session if storage is unavailable. */ }
  applyDeveloperControls(normalized)
}
