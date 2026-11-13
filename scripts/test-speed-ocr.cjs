const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
function load(relative) {
  const filename = path.resolve(__dirname, relative)
  const m = new Module(filename, module)
  m.filename = filename; m.paths = module.paths
  m._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, filename)
  return m.exports
}
const { parseSpeedTiles, StableSpeedReading, EMPTY_SPEED } = load('../src/shared/speedOcr.ts')
const { findSpeedBox } = load('../src/shared/speedBox.ts')
const word = (text, x, confidence = .96) => ({ text, x, y: .3, width: .1, height: .4, confidence })

test('reads limit and current speed as different fields; dash remains unavailable', () => {
  assert.deepEqual(parseSpeedTiles([word('35', .1), word('--', .45), word('mph', .78)], true), {limit:35,current:null,unit:'mph'})
  assert.deepEqual(parseSpeedTiles([word('35', .1), word('28', .45), word('mph', .78)], true), {limit:35,current:28,unit:'mph'})
  assert.deepEqual(parseSpeedTiles([word('0', .45), word('km/h', .78)], false), {limit:null,current:0,unit:'km/h'})
})
test('rejects ambiguous, low-confidence, unitless or implausible reads', () => {
  assert.deepEqual(parseSpeedTiles([word('35', .1)], true), EMPTY_SPEED)
  assert.equal(parseSpeedTiles([word('35', .1, .3), word('mph', .78)], true).limit, null)
  assert.equal(parseSpeedTiles([word('35', .1), word('mph', .78)], false).limit, null)
  assert.equal(parseSpeedTiles([word('35', .1), word('55', .2), word('mph', .78)], true).limit, null)
  assert.equal(parseSpeedTiles([word('350', .1), word('mph', .78)], true).limit, null)
  assert.deepEqual(parseSpeedTiles([word('35', .1), word('mph', .78), word('kph', .8)], true), EMPTY_SPEED)
})
test('requires repeated reads and clears a changed or missing limit immediately', () => {
  const gate = new StableSpeedReading(), limit = {limit:35,current:null,unit:'mph'}
  assert.equal(gate.accept(limit).limit, null)
  assert.equal(gate.accept(limit).limit, 35)
  assert.equal(gate.accept({...limit,limit:25}).limit, null)
  assert.equal(gate.accept({...limit,limit:25}).limit, 25)
  assert.equal(gate.accept(EMPTY_SPEED).limit, null)
  assert.equal(gate.accept(limit).limit, null)
  gate.accept(limit); gate.reset()
  assert.equal(gate.accept(limit).limit, null)
})
test('finds neutral sign backgrounds, ignores colored map labels and circular controls', () => {
  function image() { const data = new Uint8ClampedArray(200 * 240 * 4); for(let i=0;i<data.length;i+=4)data.set([30,100,140,255],i);return {width:200,height:240,data} }
  function fill(im,x,y,w,h,color) {for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++)im.data.set([...color,255],(yy*im.width+xx)*4)}
  const colored=image(); fill(colored,55,60,50,65,[70,210,240])
  assert.equal(findSpeedBox(colored),null)
  const sign=image(); fill(sign,55,60,50,65,[235,235,230]); fill(sign,70,80,15,25,[20,20,20])
  const found=findSpeedBox(sign)
  assert.ok(found?.limit)
  assert.ok(found.current.x>found.limit.x)
  const dark=image(); fill(dark,145,60,35,60,[15,15,18])
  assert.equal(findSpeedBox(dark)?.limit,null)
  const square=image(); fill(square,145,60,35,35,[15,15,18])
  assert.equal(findSpeedBox(square),null)
})
