import { chmod, copyFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

// An AppImage exports its own source path. This post-build step lets the
// updater shipped in older releases install the newly built image too.
const targetValue = process.env.ROUND_CARPLAY_APPIMAGE?.trim() || process.env.APPIMAGE?.trim()

if (!targetValue) {
  console.log('APPIMAGE is not set; the built image remains in dist')
  process.exit(0)
}

const outputPath = resolve('dist')
const entries = await readdir(outputPath, { withFileTypes: true })
const appImages = entries.filter(
  (entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.appimage')
)
const armImages = appImages.filter((entry) => entry.name.toLowerCase().includes('arm64'))
const candidates = armImages.length ? armImages : appImages

if (!candidates.length) {
  throw new Error(`No AppImage found in ${outputPath}`)
}

const datedCandidates = await Promise.all(
  candidates.map(async (entry) => {
    const path = resolve(outputPath, entry.name)
    return { path, modified: (await stat(path)).mtimeMs }
  })
)
datedCandidates.sort((left, right) => right.modified - left.modified)

const sourcePath = datedCandidates[0].path
const targetPath = resolve(targetValue)

if (sourcePath === targetPath) {
  await chmod(targetPath, 0o755)
  console.log(`AppImage ready at ${targetPath}`)
  process.exit(0)
}

const temporaryPath = `${targetPath}.update-${process.pid}`
try {
  await copyFile(sourcePath, temporaryPath)
  await chmod(temporaryPath, 0o755)
  await rename(temporaryPath, targetPath)
} catch (error) {
  await unlink(temporaryPath).catch(() => undefined)
  throw error
}

console.log(`Installed AppImage at ${targetPath}`)
