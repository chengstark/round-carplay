import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repository = resolve(process.cwd())
const renderer = join(repository, 'out', 'renderer')
const server = join(repository, 'out', 'main')
if (!existsSync(join(renderer, 'index.html')) || !existsSync(join(server, 'backend.js'))) {
  throw new Error('Run npm run build:browser before packaging browser artifacts')
}

const revision = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
  cwd: repository,
  encoding: 'utf8'
}).trim()
const output = join(repository, 'dist', 'browser')
const temporary = mkdtempSync(join(tmpdir(), 'round-carplay-package-'))
const full = join(temporary, 'full')
mkdirSync(output, { recursive: true })
mkdirSync(full, { recursive: true })
cpSync(server, join(full, 'server'), { recursive: true })
cpSync(renderer, join(full, 'ui'), { recursive: true })

const uiArchive = join(output, `round-carplay-ui-${revision}.tar.gz`)
const runtimeArchive = join(output, `round-carplay-browser-${revision}.tar.gz`)
execFileSync('tar', ['-czf', uiArchive, '-C', renderer, '.'])
execFileSync('tar', ['-czf', runtimeArchive, '-C', full, '.'])

console.log(
  JSON.stringify(
    {
      version: revision,
      browserUi: { file: uiArchive, sha256: digest(uiArchive) },
      browserRuntime: { file: runtimeArchive, sha256: digest(runtimeArchive) }
    },
    null,
    2
  )
)
rmSync(temporary, { recursive: true, force: true })

function digest(path) {
  const data = execFileSync('shasum', ['-a', '256', path], { encoding: 'utf8' })
  return data.split(/\s+/)[0]
}
