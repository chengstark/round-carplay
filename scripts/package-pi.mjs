import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const sourceFlag = args.indexOf('--playport-source')
if (sourceFlag < 0 || !args[sourceFlag + 1]) throw new Error('Usage: node scripts/package-pi.mjs --playport-source /path/to/current/playport [--include-private-identity] [--brightness-profile /path/to/profile.json]')
const host = resolve(args[sourceFlag + 1])
const includeIdentity = args.includes('--include-private-identity')
const brightnessFlag = args.indexOf('--brightness-profile')
const buildRoot = join(repository, 'dist', 'pi-build')
const stagedHost = join(buildRoot, 'playport-source')
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const output = join(repository, 'dist', 'pi', stamp)
const bundle = join(output, 'round-carplay-pi')
mkdirSync(bundle, { recursive: true, mode: 0o700 })
mkdirSync(stagedHost, { recursive: true })

function run(command, params, cwd = repository) {
  execFileSync(command, params, { cwd, stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } })
}
function copy(source, target) {
  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target, { recursive: true, filter: file => !file.includes('/__pycache__') && !file.endsWith('/.DS_Store') && !file.split('/').at(-1).startsWith('test_') })
}
// Build the live working tree, including uncommitted changes. Never download a
// published release or substitute the old playport-host copy.
run(join(repository, 'node_modules/.bin/esbuild'), [
  'src/backend/index.ts', '--bundle', '--platform=node', '--format=cjs', '--target=node20',
  '--external:bufferutil', '--external:utf-8-validate', `--outfile=${join(bundle, 'dashboard/backend.cjs')}`
])
run(join(repository, 'node_modules/.bin/vite'), ['build', '--config', 'vite.renderer.config.ts', '--logLevel', 'warn'])
copy(join(repository, 'out/renderer'), join(bundle, 'dashboard/ui'))

// Gradle writes only to this disposable copy; the current PlayPort checkout is
// read-only input. JAR bytecode is portable; compile the tiny BlueZ C bridge on Pi.
for (const name of ['gradlew', 'gradle', 'build.gradle.kts', 'settings.gradle.kts', 'gradle.properties']) {
  if (existsSync(join(host, name))) copy(join(host, name), join(stagedHost, name))
}
for (const name of ['server', 'protocol']) {
  rmSync(join(stagedHost, name, 'src'), { recursive: true, force: true })
  copy(join(host, name, 'src'), join(stagedHost, name, 'src'))
  copy(join(host, name, 'build.gradle.kts'), join(stagedHost, name, 'build.gradle.kts'))
}
run('bash', ['./gradlew', '--offline', '--no-daemon', ':server:installDist'], stagedHost)
copy(join(stagedHost, 'server/build/install/server'), join(bundle, 'playport'))
copy(join(host, 'web/dist'), join(bundle, 'playport/web/dist'))
for (const name of ['main.c', 'build.sh']) copy(join(host, 'linux/bt-bridge', name), join(bundle, 'playport/linux/bt-bridge', name))
copy(join(repository, 'deploy/pi'), join(bundle, 'deploy'))
for (const name of ['round-carplay-scan-wifi', 'round-carplay-connect-wifi']) copy(join(repository, 'scripts', name), join(bundle, 'deploy', name))
if (includeIdentity) {
  for (const name of ['identity.pk8', 'certificate.p7b']) {
    const target = join(bundle, 'private/identity/offline-mfi', name)
    copy(join(host, 'identity/offline-mfi', name), target)
    chmodSync(target, 0o600)
  }
}
if (brightnessFlag >= 0) {
  const profile = resolve(args[brightnessFlag + 1])
  JSON.parse(readFileSync(profile, 'utf8'))
  copy(profile, join(bundle, 'private/brightness.json'))
  chmodSync(join(bundle, 'private/brightness.json'), 0o600)
}
function files(root, prefix = '') {
  return readdirSync(join(root, prefix)).sort().flatMap(name => {
    const relative = prefix ? `${prefix}/${name}` : name
    return statSync(join(root, relative)).isDirectory() ? files(root, relative) : [relative]
  })
}
function revision(directory) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim()
}
const manifest = {
  format: 1, builtAt: new Date().toISOString(), target: 'raspberry-pi-os-trixie-arm64',
  runtime: 'playport-browser', includesPrivateIdentity: includeIdentity,
  dashboardRevision: revision(repository), playportRevision: revision(host),
  source: 'Current local working trees, including uncommitted changes; file hashes identify this snapshot.',
  files: files(bundle).map(path => ({ path, sha256: createHash('sha256').update(readFileSync(join(bundle, path))).digest('hex') }))
}
writeFileSync(join(bundle, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
const archive = join(output, includeIdentity ? 'round-carplay-pi-PRIVATE.tar.gz' : 'round-carplay-pi.tar.gz')
run('tar', ['-czf', archive, '-C', output, 'round-carplay-pi'])
chmodSync(archive, 0o600)
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex')
writeFileSync(`${archive}.sha256`, `${digest}  ${archive.split('/').at(-1)}\n`)
rmSync(bundle, { recursive: true })
console.log(JSON.stringify({ archive, sha256: digest, private: includeIdentity, physicalPiTested: false }, null, 2))
