import type { AppLaunchResult, CarPlayApp } from './protocol'

export type AppLaunchState = {
  state: 'idle' | 'requesting' | 'accepted' | 'displaying' | 'error'
  app?: CarPlayApp
  requestId?: string
  message?: string
}

/** Correlates a request and its fresh video; never claims foreground-app verification. */
export class AppLaunch {
  private current: AppLaunchState = { state: 'idle' }
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly send: (app: CarPlayApp, requestId: string) => boolean,
    private readonly refreshVideo: () => void,
    private readonly changed: (state: AppLaunchState) => void,
    private readonly timeoutMs = 8_000
  ) {}

  open(app: CarPlayApp): void {
    // Returning from the map does not change the continuously decoded main UI.
    if (this.current.state === 'displaying' && this.current.app === app) return
    this.clearTimer()
    const requestId = crypto.randomUUID()
    this.publish({ state: 'requesting', app, requestId })
    if (!this.send(app, requestId)) {
      this.fail('Connect your iPhone first')
      return
    }
    this.wait('The iPhone did not confirm opening the app. Try again.')
  }

  reply(result: AppLaunchResult): void {
    if (this.current.state !== 'requesting' || result.requestId !== this.current.requestId ||
        result.app !== this.current.app) return
    this.clearTimer()
    if (result.state !== 'accepted') {
      this.fail(result.message || 'The iPhone could not open the app')
      return
    }
    this.publish({ ...this.current, state: 'accepted' })
    // Only a frame submitted after this reply can reveal the requested UI.
    this.refreshVideo()
    this.wait('The CarPlay screen did not refresh. Try again.')
  }

  frame(): void {
    if (this.current.state !== 'accepted') return
    this.clearTimer()
    this.publish({ ...this.current, state: 'displaying' })
  }

  cancel(): void {
    this.clearTimer()
    this.publish({ state: 'idle' })
  }

  private fail(message: string): void {
    this.publish({ ...this.current, state: 'error', message })
  }

  private wait(message: string): void {
    this.timer = setTimeout(() => { this.timer = null; this.fail(message) }, this.timeoutMs)
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private publish(state: AppLaunchState): void {
    this.current = state
    this.changed({ ...state })
  }
}
