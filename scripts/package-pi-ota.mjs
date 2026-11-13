import { execFileSync } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const version = process.env.PI_UPDATE_VERSION
const baseUrl = process.env.PI_UPDATE_BASE_URL
const keyText = process.env.PI_UPDATE_SIGNING_KEY
if (!version || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(version) || !baseUrl?.startsWith('https://') || !keyText) {
  throw new Error('Set PI_UPDATE_VERSION, PI_UPDATE_BASE_URL and PI_UPDATE_SIGNING_KEY')
}
const repository = process.cwd()
const host = resolve(process.env.PI_PLAYPORT_BUILD || 'dist/playport-source')
const native = join(host, 'linux/bt-bridge/bt-bridge')
const elf = readFileSync(native)
if (elf.subarray(0, 6).toString('hex') !== '7f454c460201' || elf.readUInt16LE(18) !== 183) {
  throw new Error('Build the Bluetooth bridge on Linux ARM64 before packaging OTA')
}
const output = resolve('dist/pi-ota')
mkdirSync(output, { recursive: true })
const temporary = mkdtempSync(join(tmpdir(), 'round-carplay-ota-'))
const payload = join(temporary, 'round-carplay-update')
mkdirSync(join(payload, 'dashboard'), { recursive: true })
execFileSync(join(repository, 'node_modules/.bin/esbuild'), ['src/backend/index.ts', '--bundle', '--platform=node',
  '--format=cjs', '--target=node20', '--external:bufferutil', '--external:utf-8-validate',
  `--outfile=${join(payload, 'dashboard/backend.cjs')}`], { stdio: 'inherit' })
execFileSync(join(repository, 'node_modules/.bin/vite'), ['build', '--config', 'vite.renderer.config.ts', '--logLevel', 'warn'], { stdio: 'inherit' })
cpSync('out/renderer', join(payload, 'dashboard/ui'), { recursive: true })
cpSync(join(host, 'server/build/install/server'), join(payload, 'playport'), { recursive: true })
mkdirSync(join(payload, 'playport/linux/bt-bridge'), { recursive: true })
cpSync(native, join(payload, 'playport/linux/bt-bridge/bt-bridge'))
cpSync('deploy/pi', join(payload, 'deploy'), { recursive: true,
  filter: name => !name.includes('__pycache__') && !name.endsWith('.DS_Store') && !name.split('/').at(-1).startsWith('test_') })
// No credentials, node_modules, Mac binaries or device pairing state are copied.
const sequence = Number(process.env.PI_UPDATE_SEQUENCE || Date.now())
writeFileSync(join(payload, 'release.json'), JSON.stringify({ version, sequence }) + '\n')
const filename = `round-carplay-${version}-linux-arm64.tar.gz`
const archive = join(output, filename)
execFileSync('tar', ['-czf', archive, '-C', temporary, 'round-carplay-update'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
const bytes = readFileSync(archive)
if (bytes.length > 128 * 1024 * 1024) throw new Error('Pi update exceeds the device download limit')
const release = { schemaVersion: 1, channel: 'browser-kiosk', target: 'linux-arm64-trixie', version, sequence,
  url: `${baseUrl.replace(/\/$/, '')}/${filename}`, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
const privateKey = createPrivateKey(keyText)
const configured = JSON.parse(readFileSync('deploy/pi/pi-update.json', 'utf8'))
if (createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString().trim() !== configured.publicKey.trim()) {
  throw new Error('The signing key does not match the public key provisioned on the Pi')
}
const body = Buffer.from(JSON.stringify(release))
writeFileSync(join(output, 'pi-v3.json'), JSON.stringify({ payload: body.toString('base64'),
  signature: sign(null, body, privateKey).toString('base64') }) + '\n')
rmSync(temporary, { recursive: true })
console.log(`Prepared signed v3 update ${version} (${Math.round(bytes.length / 1024 / 1024)} MiB)`)
