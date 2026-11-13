import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const source = resolve(process.argv[2] || 'vendor/playport')
const output = resolve('vendor')
const temporary = mkdtempSync(join(tmpdir(), 'playport-source-'))
mkdirSync(output, { recursive: true })
for (const path of ['LICENSE', 'gradlew', 'gradle', 'gradle.properties', 'build.gradle.kts', 'settings.gradle.kts',
  'server/src', 'server/build.gradle.kts', 'protocol/src', 'protocol/build.gradle.kts', 'linux/bt-bridge/main.c', 'linux/bt-bridge/build.sh']) {
  if (!existsSync(join(source, path))) throw new Error(`Missing current PlayPort source: ${path}`)
  mkdirSync(join(temporary, path, '..'), { recursive: true })
  cpSync(join(source, path), join(temporary, path), { recursive: true })
}
const archive = join(output, 'playport-source.tar.gz')
execFileSync('tar', ['-czf', archive, '-C', temporary, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
writeFileSync(join(output, 'playport-source.json'), JSON.stringify({
  upstream: 'https://github.com/youcci/playport',
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(),
  note: 'Snapshot includes the current local modifications used by ROUNDSCREENCARPLAY; no identity or runtime state.',
  sha256: createHash('sha256').update(readFileSync(archive)).digest('hex')
}, null, 2) + '\n')
rmSync(temporary, { recursive: true })
console.log('Prepared current PlayPort source snapshot for the v3 GitHub build')
