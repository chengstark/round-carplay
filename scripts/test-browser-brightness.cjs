// All controller HTTP calls are mocked: this test never contacts hardware.
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const http = require('node:http')
const Module = require('node:module')
const path = require('node:path')
const { test, mock } = require('node:test')
const ts = require('typescript')

const filename = path.resolve(__dirname, '../src/main/brightness/BrightnessService.ts')
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const loaded = new Module(filename, module)
loaded.filename = filename
loaded.paths = module.paths
loaded._compile(compiled, filename)
const { BrightnessService } = loaded.exports

test('authenticated browser brightness service', async t => {
  const profilePath = '/private/tmp/round-brightness-mock.json'
  const previous = process.env.CN5_BRIGHTNESS_PROFILE
  process.env.CN5_BRIGHTNESS_PROFILE = profilePath
  t.after(() => {
    mock.restoreAll()
    if (previous === undefined) delete process.env.CN5_BRIGHTNESS_PROFILE
    else process.env.CN5_BRIGHTNESS_PROFILE = previous
  })
  let configured = true
  let firmware = 'v5'
  let failStart = false
  let host = '192.168.1.9'
  const requests = []
  mock.method(fs, 'existsSync', file => configured && file === profilePath)
  mock.method(fs, 'readFileSync', () => JSON.stringify({ host, token: 'a'.repeat(64) }))
  mock.method(http, 'request', (options, callback) => {
    const req = new EventEmitter()
    let body = ''
    req.write = value => { body += value }
    req.destroy = error => req.emit('error', error)
    req.end = () => process.nextTick(() => {
      const command = new URLSearchParams(body).get('command')
      requests.push({ ...options, command })
      if (failStart && command === 'LEFT_START') {
        req.emit('error', new Error('Lost reply'))
        return
      }
      const response = new EventEmitter()
      response.statusCode = 200
      callback(response)
      response.emit('data', Buffer.from(JSON.stringify({
        firmware, mode: 'DIRECT_OPEN_DRAIN',
        left: command === 'LEFT_START' ? 'PRESSED' : 'RELEASED',
        right: command === 'RIGHT_START' ? 'PRESSED' : 'RELEASED'
      })))
      response.emit('end')
    })
    return req
  })

  await t.test('status is read-only and never exposes credentials', async () => {
    requests.length = 0
    const result = await new BrightnessService('/unused').getStatus()
    assert.equal(result.ok, true)
    assert.deepEqual(requests.map(r => r.method), ['GET'])
    assert.equal(requests[0].headers.Authorization, `Bearer ${'a'.repeat(64)}`)
    assert.equal(JSON.stringify(result).includes('a'.repeat(64)), false)
  })
  await t.test('rejects unexpected firmware before arming', async () => {
    requests.length = 0
    firmware = 'v2'
    assert.equal((await new BrightnessService('/unused').start('increase')).ok, false)
    assert.deepEqual(requests.map(r => r.method), ['GET'])
    firmware = 'v5'
  })
  await t.test('quick release is queued after START, then OFF', async () => {
    requests.length = 0
    const service = new BrightnessService('/unused')
    const startedAt = Date.now()
    const results = await Promise.all([service.start('decrease'), service.stop()])
    assert.ok(Date.now() - startedAt >= 1_000, 'a tap applies a one-second adjustment')
    assert.equal(results[1].active, null)
    assert.deepEqual(requests.map(r => r.command), [null, 'ARM', 'RIGHT_START', 'OFF'])
  })
  await t.test('recent status makes press start in two requests', async () => {
    const service = new BrightnessService('/unused')
    await service.getStatus()
    requests.length = 0
    assert.equal((await service.start('increase')).active, 'increase')
    assert.deepEqual(requests.map(r => r.command), ['ARM', 'LEFT_START'])
    await service.stop(true)
  })
  await t.test('changed controller profile requires fresh verification', async () => {
    const service = new BrightnessService('/unused')
    await service.getStatus()
    host = '192.168.1.10'
    requests.length = 0
    await service.start('increase')
    assert.deepEqual(requests.map(r => r.command), [null, 'ARM', 'LEFT_START'])
    await service.stop(true)
    host = '192.168.1.9'
  })
  await t.test('expired verification checks status again before arming', async () => {
    const service = new BrightnessService('/unused')
    const realNow = Date.now
    let now = realNow()
    const clock = mock.method(Date, 'now', () => now)
    try {
      await service.getStatus()
      now += 15_001
      requests.length = 0
      await service.start('decrease')
      assert.deepEqual(requests.map(r => r.command), [null, 'ARM', 'RIGHT_START'])
      now += 1_000
      await service.stop()
    } finally {
      clock.mock.restore()
    }
  })
  await t.test('cancellation interrupts a pending tap adjustment immediately', async () => {
    const service = new BrightnessService('/unused')
    await service.start('decrease')
    requests.length = 0
    const startedAt = Date.now()
    const normalRelease = service.stop()
    // Let the normal release enter its minimum-duration wait first.
    await new Promise(resolve => setImmediate(resolve))
    const immediateRelease = service.stop(true)
    await Promise.all([normalRelease, immediateRelease])
    assert.ok(Date.now() - startedAt < 500, 'cancel bypasses the one-second tap duration')
    assert.deepEqual(requests.map(r => r.command), ['OFF', 'OFF'])
  })
  await t.test('unexpected ARM response releases outputs without START', async () => {
    const service = new BrightnessService('/unused')
    await service.getStatus()
    firmware = 'v2'
    requests.length = 0
    assert.equal((await service.start('increase')).ok, false)
    assert.deepEqual(requests.map(r => r.command), ['ARM', 'OFF'])
    firmware = 'v5'
  })
  await t.test('uncertain START delivery attempts release without repeating START', async () => {
    requests.length = 0
    failStart = true
    assert.equal((await new BrightnessService('/unused').start('increase')).ok, false)
    assert.deepEqual(requests.map(r => r.command), [null, 'ARM', 'LEFT_START', 'OFF'])
    failStart = false
  })
  await t.test('missing profile makes no network request', async () => {
    requests.length = 0
    configured = false
    assert.equal((await new BrightnessService('/unused').start('increase')).configured, false)
    assert.equal(requests.length, 0)
  })
})
