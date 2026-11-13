import { execFile } from 'node:child_process'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { get } from 'node:https'
import type { SystemUpdateStatus } from '../main/update/SystemUpdateService'

const exec = promisify(execFile)
const MAX_DOWNLOAD = 128 * 1024 * 1024
type Listener = (status: SystemUpdateStatus) => void
export type PiUpdateConfig = { manifestUrl: string; publicKey: string; automatic?: boolean }
type Release = {
  schemaVersion: 1; channel: 'browser-kiosk'; target: 'linux-arm64-trixie'
  version: string; sequence: number; url: string; sha256: string; size: number
}
type Options = {
  root?: string
  config?: PiUpdateConfig | null
  fetch?: typeof fetch
  busy?: () => Promise<boolean>
  command?: (action: 'stage' | 'schedule', input: string) => Promise<string>
}

/** Signed, prebuilt v3 updates. No Git, npm, Gradle or compilation on the Pi. */
export class PiUpdateService {
  private running = false
  private attempted = false
  private status: SystemUpdateStatus = { state: 'idle', message: 'Check for v3 updates' }
  private readonly root: string
  private readonly config: PiUpdateConfig | null
  private readonly fetcher: typeof fetch
  private readonly command: NonNullable<Options['command']>
  private readonly busy: () => Promise<boolean>
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(options: Options = {}) {
    this.root = options.root || join(homedir(), '.local/share/round-carplay-pi')
    this.config = options.config === undefined ? readConfig() : options.config
    this.fetcher = options.fetch || fetch
    this.busy = options.busy || carplayBusy
    this.command = options.command || (async (action, input) => {
      if (action === 'stage') {
        // Archive extraction/validation is unprivileged. The fixed root helper
        // only restarts services, checks health, and restores the previous link.
        const { stdout } = await exec('python3', ['/usr/local/lib/round-carplay/update.py', 'stage', input], {
          timeout: 120_000, maxBuffer: 64 * 1024
        })
        return stdout.trim()
      }
      await exec('sudo', ['-n', '/usr/local/sbin/round-carplay-update', 'schedule'], { timeout: 15_000 })
      return ''
    })
  }

  getStatus(): SystemUpdateStatus {
    if (!this.running && (!this.attempted || this.status.state === 'installing')) {
      const result = readJson(join(this.root, 'update-result.json'))
      if (result && typeof result.message === 'string' && ['success', 'error', 'idle'].includes(result.state)) {
        return { state: result.state, message: result.message }
      }
      if (existsSync(join(this.root, 'pending-update.json'))) {
        return { state: 'installing', message: 'Applying update. The dashboard will reconnect automatically.' }
      }
    }
    return { ...this.status }
  }

  startAutomatic(listener: Listener): void {
    if (!this.config || this.config.automatic === false || process.env.ROUND_CARPLAY_DISABLE_AUTO_UPDATE === '1') return
    const run = () => {
      void this.update(listener, true).then(status => {
        if (this.stopped) return
        const minutes = ['idle', 'installing'].includes(status.state) ? 5 : status.state === 'error' ? 15 : 360
        this.timer = setTimeout(run, minutes * 60_000)
        this.timer.unref()
      })
    }
    this.timer = setTimeout(run, 2 * 60_000)
    this.timer.unref()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  async update(listener: Listener, automatic = false): Promise<SystemUpdateStatus> {
    if (this.running) return this.getStatus()
    if (!this.config) return this.publish('error', 'The v3 update feed has not been configured', listener)
    this.attempted = true
    this.running = true
    let directory: string | undefined
    let pendingCreated = false
    try {
      this.publish('pulling', 'Checking the v3 update feed…', listener)
      requireHttps(this.config.manifestUrl)
      const response = await this.fetcher(this.config.manifestUrl, { signal: AbortSignal.timeout(20_000) })
      if (response.status === 404) throw new Error('No v3 update release has been published yet')
      if (!response.ok) throw new Error(`Update feed returned HTTP ${response.status}`)
      const envelope = JSON.parse((await limitedBody(response, 128_000)).toString())
      const release = verifyRelease(envelope, this.config.publicKey)
      const installed = readJson(join(this.root, 'current/release.json'))
      if (installed?.version === release.version) return this.publish('no-update', 'Your v3 dashboard is up to date', listener)
      if (installed?.sequence && release.sequence <= installed.sequence) throw new Error('The update feed contains an older release')
      const result = readJson(join(this.root, 'update-result.json'))
      if (automatic && result?.failedVersion === release.version) {
        return this.publish('error', 'The previous update failed. Waiting for a newer release; you can retry manually.', listener)
      }
      if (automatic && await this.busy()) {
        return this.publish('idle', 'An update is available. It will install while CarPlay is idle.', listener)
      }
      mkdirSync(join(this.root, 'downloads'), { recursive: true, mode: 0o700 })
      directory = await mkdtemp(join(this.root, 'downloads/update-'))
      this.publish('pulling', `Downloading v3 ${release.version}…`, listener)
      const artifact = await this.fetcher(release.url, { signal: AbortSignal.timeout(180_000) })
      if (!artifact.ok) throw new Error(`Update download returned HTTP ${artifact.status}`)
      const bytes = await limitedBody(artifact, Math.min(MAX_DOWNLOAD, release.size))
      if (bytes.length !== release.size || createHash('sha256').update(bytes).digest('hex') !== release.sha256) {
        throw new Error('Update checksum did not match the signed release')
      }
      const archive = join(directory, 'update.tar.gz')
      await writeFile(archive, bytes, { mode: 0o600 })
      await writeFile(join(directory, 'release.json'), JSON.stringify(release), { mode: 0o600 })
      this.publish('installing', 'Validating the new dashboard…', listener)
      const staged = await this.command('stage', directory)
      if (automatic && await this.busy()) {
        // A phone may have connected during the download. Never interrupt it.
        await rm(staged, { recursive: true, force: true })
        return this.publish('idle', 'Update downloaded. Installation will retry while CarPlay is idle.', listener)
      }
      const old = readJson(join(this.root, 'pending-update.json'))
      if (old) throw new Error('Another update is already waiting to be applied')
      await writeFile(join(this.root, 'pending-update.json'), JSON.stringify({
        candidate: staged, version: release.version, sequence: release.sequence, automatic
      }), { mode: 0o600, flag: 'wx' })
      pendingCreated = true
      await rm(join(this.root, 'update-result.json'), { force: true })
      await this.command('schedule', '')
      return this.publish('installing', 'Applying update. The dashboard will reconnect automatically.', listener)
    } catch (error) {
      if (pendingCreated) await rm(join(this.root, 'pending-update.json'), { force: true })
      return this.publish('error', error instanceof Error ? error.message : 'Update failed', listener)
    } finally {
      this.running = false
      if (directory) await rm(directory, { recursive: true, force: true })
    }
  }

  private publish(state: SystemUpdateStatus['state'], message: string, listener: Listener): SystemUpdateStatus {
    this.status = { state, message }
    listener({ ...this.status })
    return { ...this.status }
  }
}

export function verifyRelease(envelope: { payload?: unknown; signature?: unknown }, publicKey: string): Release {
  if (typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') throw new Error('Invalid signed update feed')
  const payload = Buffer.from(envelope.payload, 'base64')
  const key = createPublicKey(publicKey)
  if (payload.length > 64_000 || key.asymmetricKeyType !== 'ed25519' ||
      !verify(null, payload, key, Buffer.from(envelope.signature, 'base64'))) throw new Error('Update signature is invalid')
  const release = JSON.parse(payload.toString()) as Release
  if (release.schemaVersion !== 1 || release.channel !== 'browser-kiosk' || release.target !== 'linux-arm64-trixie' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(release.version) || !Number.isSafeInteger(release.sequence) || release.sequence < 1 ||
      !/^[a-f0-9]{64}$/.test(release.sha256) || !Number.isSafeInteger(release.size) || release.size < 1 || release.size > MAX_DOWNLOAD) {
    throw new Error('Update is incompatible with this v3 Pi deployment')
  }
  requireHttps(release.url)
  return release
}

async function limitedBody(response: Response, maximum: number): Promise<Buffer> {
  if (response.url) requireHttps(response.url)
  if (!response.body || Number(response.headers.get('content-length') || 0) > maximum) throw new Error('Update download exceeds its size limit')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > maximum) throw new Error('Update download exceeds its size limit')
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
  } finally { await reader.cancel().catch(() => undefined) }
}

function readConfig(): PiUpdateConfig | null {
  return readJson('/etc/round-carplay/pi-update.json') as PiUpdateConfig | null
}
function readJson(path: string): any {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null } catch { return null }
}
function requireHttps(url: string): void {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Updates require an HTTPS URL')
}
function carplayBusy(): Promise<boolean> {
  return new Promise(resolve => {
    // Self-signed TLS is accepted only for our fixed loopback host status API.
    const request = get('https://127.0.0.1:8080/api/status', { rejectUnauthorized: false, timeout: 3_000 }, response => {
      let body = ''
      response.on('data', data => { body += data; if (body.length > 64_000) request.destroy() })
      response.on('end', () => {
        try { resolve(JSON.parse(body).sessionActive !== false) } catch { resolve(true) }
      })
    })
    request.on('timeout', () => { request.destroy(); resolve(true) })
    request.on('error', () => resolve(true))
  })
}
