const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
function load(relative, dependencies = {}) {
  const filename = path.resolve(__dirname, relative)
  const m = new Module(filename, module)
  m.filename = filename; m.paths = module.paths
  const original = m.require.bind(m)
  m.require = name => dependencies[name] || original(name)
  m._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, filename)
  return m.exports
}
const protocol = load('../src/renderer/src/playport/protocol.ts')
const { PlayPortVideo } = load('../src/renderer/src/playport/video.ts', { './protocol': protocol })

test('slow decoding stays bounded and waits for a new H.264 reference frame after reset', t => {
  const previousDecoder = global.VideoDecoder, previousChunk = global.EncodedVideoChunk
  t.after(() => { global.VideoDecoder = previousDecoder; global.EncodedVideoChunk = previousChunk })
  let decoder, requests = 0
  global.VideoDecoder = class {
    state = 'unconfigured'; decodeQueueSize = 0; resets = 0; frames = []
    constructor() { decoder = this }
    configure() { this.state = 'configured' }
    reset() { this.decodeQueueSize = 0; this.resets++; this.state = 'unconfigured' }
    decode(chunk) { this.frames.push(chunk); this.decodeQueueSize++ }
    close() { this.state = 'closed' }
  }
  global.EncodedVideoChunk = class { constructor(value) { Object.assign(this, value) } }
  const player = new PlayPortVideo({}, () => {}, error => assert.equal(error, ''), () => requests++)
  player.configure({ codec: 1, width: 512, height: 512, codecData: new Uint8Array(), streamType: 111 })
  const frame = keyframe => ({ keyframe, data: Uint8Array.from([0, 0, 0, 1, keyframe ? 0x65 : 0x41]) })
  for (let i = 0; i < 20; i++) player.push(frame(false))
  assert.equal(decoder.frames.length, 0, 'startup deltas cannot establish decoder references')
  player.push(frame(true))
  for (let i = 0; i < 100; i++) player.push(frame(false))
  assert.equal(decoder.resets, 1)
  assert.equal(decoder.decodeQueueSize, 0)
  assert.equal(decoder.frames.length, 6)
  assert.equal(requests, 1, 'keyframe requests must not flood the host')
  player.push(frame(true))
  assert.equal(decoder.decodeQueueSize, 1)
  assert.equal(decoder.frames.at(-1).type, 'key')
  player.close()
})
