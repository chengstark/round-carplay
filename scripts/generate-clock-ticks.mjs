import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configPath = resolve(
  projectRoot,
  'src/renderer/src/components/clock/clockFace.json'
)
const outputPath = resolve(
  projectRoot,
  'src/renderer/src/components/clock/generatedTickPositions.ts'
)

const args = new Set(process.argv.slice(2))
const checkOnly = args.has('--check')
const previewIndex = process.argv.indexOf('--preview')
const previewPath = previewIndex >= 0 ? process.argv[previewIndex + 1] : undefined

if (previewIndex >= 0 && !previewPath) {
  throw new Error('--preview requires an output path')
}

const config = JSON.parse(await readFile(configPath, 'utf8'))
const { size, dialRadius, ticks } = config
const center = size / 2

validateConfig()

const positions = Array.from({ length: ticks.count }, (_, index) => {
  const isMajor = index % ticks.majorEvery === 0
  const angleDeg = (index * 360) / ticks.count
  const innerRadius =
    ticks.outerRadius - (isMajor ? ticks.majorLength : ticks.minorLength)

  return {
    index,
    angleDeg,
    isMajor,
    inner: polar(innerRadius, angleDeg),
    outer: polar(ticks.outerRadius, angleDeg)
  }
})

validatePositions(positions)

const generatedSource = renderTypeScript(positions)
let currentSource = ''

try {
  currentSource = await readFile(outputPath, 'utf8')
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

if (checkOnly) {
  if (currentSource !== generatedSource) {
    console.error('Clock tick positions are stale. Run: npm run clock:generate')
    process.exitCode = 1
  } else {
    console.log(`Clock geometry OK: ${positions.length} ticks at ${360 / ticks.count} degrees`)
  }
} else if (currentSource !== generatedSource) {
  await writeFile(outputPath, generatedSource)
  console.log(`Generated ${positions.length} clock ticks in ${outputPath}`)
} else {
  console.log(`Clock tick positions already current: ${outputPath}`)
}

if (previewPath) {
  const absolutePreviewPath = resolve(process.cwd(), previewPath)
  await mkdir(dirname(absolutePreviewPath), { recursive: true })
  await writeFile(absolutePreviewPath, renderPreview(positions))
  console.log(`Wrote clock tick preview to ${absolutePreviewPath}`)
}

function polar(radius, angleDeg) {
  const radians = ((angleDeg - 90) * Math.PI) / 180
  return {
    x: round(center + radius * Math.cos(radians)),
    y: round(center + radius * Math.sin(radians))
  }
}

function round(value) {
  const factor = 10 ** ticks.coordinatePrecision
  const rounded = Math.round(value * factor) / factor
  return Object.is(rounded, -0) ? 0 : rounded
}

function validateConfig() {
  const numbers = [
    size,
    dialRadius,
    ticks.count,
    ticks.majorEvery,
    ticks.outerRadius,
    ticks.minorLength,
    ticks.majorLength,
    ticks.minorWidth,
    ticks.majorWidth,
    ticks.coordinatePrecision
  ]

  if (numbers.some(value => !Number.isFinite(value))) {
    throw new Error('Every clock-face geometry value must be a finite number')
  }
  if (ticks.count <= 0 || ticks.count % 2 !== 0 || ticks.count % ticks.majorEvery !== 0) {
    throw new Error('Tick count must be positive, even, and divisible by majorEvery')
  }
  if (ticks.outerRadius > dialRadius) {
    throw new Error('Tick ring must fit inside the dial')
  }
  if (ticks.majorLength <= ticks.minorLength) {
    throw new Error('Major ticks must be longer than minor ticks')
  }
  if (!Number.isInteger(ticks.coordinatePrecision) || ticks.coordinatePrecision < 0) {
    throw new Error('coordinatePrecision must be a non-negative integer')
  }
}

function validatePositions(generated) {
  const tolerance = 10 ** -ticks.coordinatePrecision * 1.5

  for (const mark of generated) {
    const innerRadius = Math.hypot(mark.inner.x - center, mark.inner.y - center)
    const outerRadius = Math.hypot(mark.outer.x - center, mark.outer.y - center)
    const expectedInnerRadius =
      ticks.outerRadius - (mark.isMajor ? ticks.majorLength : ticks.minorLength)

    if (Math.abs(innerRadius - expectedInnerRadius) > tolerance) {
      throw new Error(`Tick ${mark.index} has an invalid inner radius`)
    }
    if (Math.abs(outerRadius - ticks.outerRadius) > tolerance) {
      throw new Error(`Tick ${mark.index} has an invalid outer radius`)
    }

    const opposite = generated[(mark.index + ticks.count / 2) % ticks.count]
    if (
      Math.abs(mark.inner.x + opposite.inner.x - size) > tolerance ||
      Math.abs(mark.inner.y + opposite.inner.y - size) > tolerance ||
      Math.abs(mark.outer.x + opposite.outer.x - size) > tolerance ||
      Math.abs(mark.outer.y + opposite.outer.y - size) > tolerance
    ) {
      throw new Error(`Tick ${mark.index} is not symmetric with its opposite`)
    }
  }
}

function renderTypeScript(generated) {
  const records = generated
    .map(mark => {
      return `  { index: ${mark.index}, angleDeg: ${mark.angleDeg}, isMajor: ${mark.isMajor}, x1: ${mark.inner.x}, y1: ${mark.inner.y}, x2: ${mark.outer.x}, y2: ${mark.outer.y} }`
    })
    .join(',\n')

  return `// Generated by scripts/generate-clock-ticks.mjs from clockFace.json.\n// Do not edit these coordinates by hand; run npm run clock:generate.\n\nexport interface TickPosition {\n  index: number\n  angleDeg: number\n  isMajor: boolean\n  x1: number\n  y1: number\n  x2: number\n  y2: number\n}\n\nexport const TICK_POSITIONS = [\n${records}\n] as const satisfies readonly TickPosition[]\n`
}

function renderPreview(generated) {
  const viewBoxStart = center - dialRadius
  const lines = generated
    .map(mark => {
      const width = mark.isMajor ? ticks.majorWidth : ticks.minorWidth
      const color = mark.isMajor ? '#e6e3db' : '#c9c6bf'
      return `  <line x1="${mark.inner.x}" y1="${mark.inner.y}" x2="${mark.outer.x}" y2="${mark.outer.y}" stroke="${color}" stroke-width="${width}" />`
    })
    .join('\n')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBoxStart} ${viewBoxStart} ${dialRadius * 2} ${dialRadius * 2}" width="504" height="504">\n  <circle cx="${center}" cy="${center}" r="${dialRadius}" fill="#08090b" />\n${lines}\n</svg>\n`
}
