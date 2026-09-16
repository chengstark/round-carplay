import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { SystemUpdateStatus } from './SystemUpdateService'

const execFileAsync = promisify(execFile)

type Artifact = { version: string; url: string; sha256: string }
type Manifest = {
  schemaVersion: 1
  protocolVersion: number
  artifacts: {
    electron?: Artifact
    browserRuntime?: Artifact
    browserUi?: Artifact
  }
}
type Versions = { electron?: string; browserRuntime?: string; browserUi?: string }
type Listener = (status: SystemUpdateStatus) => void

export class OtaUpdateService {
  private running = false
  private status: SystemUpdateStatus = { state: 'idle', message: 'Check for OTA updates' }
  private readonly manifestUrl: string | null
  private readonly releaseRoot: string
  private readonly versionFile: string

  constructor(private readonly cameraActive: () => boolean) {
    this.manifestUrl = readManifestUrl()
    this.releaseRoot = resolve(
      process.env.ROUND_CARPLAY_RELEASE_ROOT || join(homedir(), '.local', 'share', 'round-carplay')
    )
    this.versionFile = join(this.releaseRoot, 'versions.json')
  }

  isConfigured(): boolean {
    return this.manifestUrl != null
  }

  getStatus(): SystemUpdateStatus {
    return { ...this.status }
  }

  async update(listener: Listener): Promise<SystemUpdateStatus> {
    if (this.running) return this.getStatus()
    if (!this.manifestUrl) return this.publish('error', 'OTA manifest is not configured', listener)
    if (this.cameraActive()) {
      return this.publish('error', 'Close the backup camera before downloading an update', listener)
    }

    this.running = true
    const staging = join(tmpdir(), `round-carplay-ota-${process.pid}`)
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    try {
      this.publish('pulling', 'Downloading the OTA manifest…', listener)
      const manifest = await fetchJson<Manifest>(this.manifestUrl)
      validateManifest(manifest)
      const versions = readVersions(this.versionFile)
      const pending = Object.entries(manifest.artifacts).filter(
        ([kind, artifact]) => artifact && versions[kind as keyof Versions] !== artifact.version
      ) as [keyof Versions, Artifact][]
      if (!pending.length) return this.publish('no-update', 'Already up to date', listener)

      for (const [kind, artifact] of pending) {
        this.publish('pulling', `Downloading ${kind} ${artifact.version}…`, listener)
        const file = join(staging, `${kind}.artifact`)
        await download(artifact.url, file)
        if ((await sha256(file)) !== artifact.sha256.toLowerCase()) {
          throw new Error(`${kind} checksum did not match the manifest`)
        }
        this.publish('installing', `Installing ${kind} ${artifact.version}…`, listener)
        if (kind === 'electron') installElectron(file)
        else await installBrowserArtifact(kind, file, artifact.version, this.releaseRoot)
        versions[kind] = artifact.version
        writeVersions(this.versionFile, versions)
      }
      return this.publish('success', 'OTA update installed. Restart to activate it', listener)
    } catch (error) {
      return this.publish('error', `OTA update failed: ${errorMessage(error)}`, listener)
    } finally {
      this.running = false
      rmSync(staging, { recursive: true, force: true })
    }
  }

  private publish(
    state: SystemUpdateStatus['state'],
    message: string,
    listener: Listener
  ): SystemUpdateStatus {
    this.status = { state, message }
    listener(this.getStatus())
    return this.getStatus()
  }
}

function readManifestUrl(): string | null {
  const environment = process.env.ROUND_CARPLAY_UPDATE_MANIFEST_URL?.trim()
  if (environment) return environment
  try {
    const configured = readFileSync('/etc/round-carplay/update-manifest-url', 'utf8').trim()
    return configured || null
  } catch {
    return null
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Manifest returned HTTP ${response.status}`)
  return (await response.json()) as T
}

async function download(url: string, destination: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`Artifact returned HTTP ${response.status}`)
  await pipeline(
    Readable.fromWeb(response.body as any),
    createWriteStream(destination, { mode: 0o600 })
  )
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

function validateManifest(manifest: Manifest): void {
  if (manifest.schemaVersion !== 1 || manifest.protocolVersion !== 1) {
    throw new Error('Unsupported OTA manifest or protocol version')
  }
  for (const artifact of Object.values(manifest.artifacts)) {
    if (!artifact) continue
    if (
      !artifact.version ||
      !/^https?:\/\//.test(artifact.url) ||
      !/^[a-f0-9]{64}$/i.test(artifact.sha256)
    ) {
      throw new Error('Invalid OTA artifact metadata')
    }
  }
}

function installElectron(source: string): void {
  const target = resolve(
    process.env.ROUND_CARPLAY_APPIMAGE || join(homedir(), 'round-carplay', 'round-carplay.AppImage')
  )
  mkdirSync(dirname(target), { recursive: true })
  const temporary = `${target}.new-${process.pid}`
  copyFileSync(source, temporary)
  chmodSync(temporary, 0o755)
  renameSync(temporary, target)
}

async function installBrowserArtifact(
  kind: 'browserRuntime' | 'browserUi',
  archive: string,
  version: string,
  releaseRoot: string
): Promise<void> {
  await validateArchive(archive)
  const releases = join(releaseRoot, 'releases')
  const current = symlinkTarget(join(releaseRoot, 'current'))
  const staging = join(releases, `.${kind}-${version}-${Date.now()}`)
  const release = join(releases, `${kind}-${version}-${Date.now()}`)
  mkdirSync(staging, { recursive: true })

  if (kind === 'browserUi') {
    if (!current || !existsSync(join(current, 'server', 'backend.js'))) {
      throw new Error('A browser runtime must be installed before a UI-only update')
    }
    cpSync(join(current, 'server'), join(staging, 'server'), { recursive: true })
    const modules = symlinkTarget(join(current, 'node_modules'))
    if (modules) symlinkSync(modules, join(staging, 'node_modules'))
    mkdirSync(join(staging, 'ui'), { recursive: true })
    await execFileAsync('tar', ['-xzf', archive, '-C', join(staging, 'ui')])
  } else {
    await execFileAsync('tar', ['-xzf', archive, '-C', staging])
    const modules = current ? symlinkTarget(join(current, 'node_modules')) : null
    if (modules && !existsSync(join(staging, 'node_modules'))) {
      symlinkSync(modules, join(staging, 'node_modules'))
    }
  }

  if (
    !existsSync(join(staging, 'server', 'backend.js')) ||
    !existsSync(join(staging, 'ui', 'index.html'))
  ) {
    throw new Error(`${kind} archive did not contain a complete browser release`)
  }
  renameSync(staging, release)
  if (current) replaceSymlink(join(releaseRoot, 'previous'), current)
  replaceSymlink(join(releaseRoot, 'current'), release)
}

async function validateArchive(archive: string): Promise<void> {
  const { stdout } = await execFileAsync('tar', ['-tzf', archive], { encoding: 'utf8' })
  for (const entry of stdout.split(/\r?\n/).filter(Boolean)) {
    if (entry.startsWith('/') || entry.split('/').includes('..'))
      throw new Error('Unsafe OTA archive path')
  }
}

function replaceSymlink(link: string, target: string): void {
  mkdirSync(dirname(link), { recursive: true })
  const temporary = `${link}.new-${process.pid}`
  rmSync(temporary, { force: true })
  symlinkSync(target, temporary)
  renameSync(temporary, link)
}

function symlinkTarget(path: string): string | null {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null
    return resolve(dirname(path), readlinkSync(path))
  } catch {
    return null
  }
}

function readVersions(path: string): Versions {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Versions
  } catch {
    return {}
  }
}

function writeVersions(path: string, versions: Versions): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.new-${process.pid}`
  writeFileSync(temporary, JSON.stringify(versions, null, 2))
  renameSync(temporary, path)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
