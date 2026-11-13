import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'

const repository = resolve(process.cwd())
const backend = join(repository, 'out', 'main', 'backend.js')
const renderer = join(repository, 'out', 'renderer')
const nodeModules = join(repository, 'node_modules')
if (!existsSync(backend) || !existsSync(join(renderer, 'index.html'))) {
  throw new Error('Run npm run build:browser before installing the browser release')
}
if (!existsSync(nodeModules)) throw new Error('node_modules is required for the backend runtime')

const releaseRoot = resolve(
  process.env.ROUND_CARPLAY_RELEASE_ROOT || join(homedir(), '.local', 'share', 'round-carplay')
)
const revision = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
  cwd: repository,
  encoding: 'utf8'
}).trim()
const releaseName = `${revision}-${Date.now()}`
const releases = join(releaseRoot, 'releases')
const staging = join(releases, `.${releaseName}.staging`)
const release = join(releases, releaseName)
const currentLink = join(releaseRoot, 'current')
const previousLink = join(releaseRoot, 'previous')

mkdirSync(releases, { recursive: true })
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })
cpSync(join(repository, 'out', 'main'), join(staging, 'server'), { recursive: true })
cpSync(renderer, join(staging, 'ui'), { recursive: true })
symlinkSync(nodeModules, join(staging, 'node_modules'))
renameSync(staging, release)

const oldCurrent = symlinkTarget(currentLink)
if (oldCurrent && existsSync(oldCurrent)) replaceSymlink(previousLink, oldCurrent)
replaceSymlink(currentLink, release)
pruneReleases(releases, new Set([release, oldCurrent].filter(Boolean)))

console.log(`Installed browser release ${releaseName}`)
console.log(`Current: ${currentLink} -> ${release}`)

function replaceSymlink(linkPath, targetPath) {
  mkdirSync(dirname(linkPath), { recursive: true })
  const temporary = `${linkPath}.new-${process.pid}`
  rmSync(temporary, { force: true })
  symlinkSync(targetPath, temporary)
  renameSync(temporary, linkPath)
}

function symlinkTarget(linkPath) {
  try {
    if (!lstatSync(linkPath).isSymbolicLink()) return null
    const target = readlinkSync(linkPath)
    return resolve(dirname(linkPath), target)
  } catch {
    return null
  }
}

function pruneReleases(directory, retained) {
  const entries = execFileSync(
    'find',
    [directory, '-mindepth', '1', '-maxdepth', '1', '-type', 'd'],
    {
      encoding: 'utf8'
    }
  )
    .split(/\r?\n/)
    .filter(Boolean)
    .sort()
    .reverse()

  let extraKept = 0
  for (const entry of entries) {
    const resolved = resolve(entry)
    if (retained.has(resolved)) continue
    if (extraKept++ < 1) continue
    if (!basename(resolved).startsWith('.')) rmSync(resolved, { recursive: true, force: true })
  }
}
