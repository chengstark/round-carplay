const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const filename = path.resolve(__dirname, '../src/renderer/src/playport/navigation.ts')
const loaded = new Module(filename, module)
loaded.filename = filename
loaded.paths = module.paths
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, filename)
const { navigationApp, remainingTrip, arrivalTime, tripDistance } = loaded.exports

test('detects the reported navigation source without inventing one', () => {
  assert.equal(navigationApp('Apple Maps'), 'apple-maps')
  assert.equal(navigationApp('Google Maps'), 'google-maps')
  assert.equal(navigationApp('GOOGLE MAPS'), 'google-maps')
  assert.equal(navigationApp(undefined), 'unknown')
  assert.equal(navigationApp('Other navigation'), 'unknown')
})
test('formats a long remaining trip and rejects unavailable durations', () => {
  assert.equal(remainingTrip(59520), '16 h 32 min')
  assert.equal(remainingTrip(59), '1 min')
  assert.equal(remainingTrip(3600), '1 h')
  assert.equal(remainingTrip(0), '0 min')
  assert.equal(remainingTrip(undefined), null)
  assert.equal(remainingTrip(-1), null)
  assert.equal(remainingTrip(Infinity), null)
})
test('preserves navigation-provided distance units and text', () => {
  assert.equal(tripDistance({ distanceRemainingText: '1,178', distanceRemainingUnit: 1 }), '1,178 mi')
  assert.equal(tripDistance({ distanceRemainingText: '2.4 km' }), '2.4 km')
  assert.equal(tripDistance({ distanceRemainingMeters: 1609.344, distanceRemainingUnit: 1 }), '1 mi')
  assert.equal(tripDistance({}), null)
  assert.equal(tripDistance({ distanceRemainingMeters: -1 }), null)
})
test('missing or malformed ETA does not appear as a misleading clock time', () => {
  assert.equal(arrivalTime(undefined), null)
  assert.equal(arrivalTime(0), null)
  assert.equal(arrivalTime(Infinity), null)
  assert.equal(arrivalTime(1e20), null)
  assert.equal(typeof arrivalTime(1794253500), 'string')
})
