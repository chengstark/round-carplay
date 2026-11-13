const { test } = require('node:test')
const assert = require('node:assert/strict')
const { generateKeyPairSync, sign, createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const filename = path.resolve(__dirname, '../src/backend/PiUpdateService.ts')
const loaded = new Module(filename, module)
loaded.filename = filename; loaded.paths = module.paths
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, filename)
const { PiUpdateService, verifyRelease } = loaded.exports
const key = generateKeyPairSync('ed25519')
const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const bytes = Buffer.from('test-release-archive')
function release(overrides = {}) {
  return { schemaVersion: 1, channel: 'browser-kiosk', target: 'linux-arm64-trixie', version: 'v3-test',
    sequence: 100, url: 'https://updates.example/artifact.tar.gz', size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), ...overrides }
}
function envelope(value) {
  const payload = Buffer.from(JSON.stringify(value))
  return { payload: payload.toString('base64'), signature: sign(null, payload, key.privateKey).toString('base64') }
}
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-update-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const requests = [], commands = []
  const candidate = path.join(root, 'releases/new')
  fs.mkdirSync(candidate, { recursive: true })
  const service = new PiUpdateService({ root,
    config: { manifestUrl: 'https://updates.example/feed.json', publicKey }, busy: async () => false,
    fetch: async url => {
      requests.push(url)
      return url.endsWith('.json') ? new Response(JSON.stringify(envelope(release()))) : new Response(bytes)
    }, command: async (action, input) => { commands.push({ action, input }); return candidate }, ...overrides })
  t.after(() => service.stop())
  return { service, root, candidate, requests, commands }
}

test('signed feed rejects tampering, the wrong channel, old formats and insecure URLs', () => {
  assert.equal(verifyRelease(envelope(release()), publicKey).version, 'v3-test')
  const bad = envelope(release()); bad.payload = Buffer.from('{}').toString('base64')
  assert.throws(() => verifyRelease(bad, publicKey), /signature/)
  for (const invalid of [{ channel: 'main' }, { target: 'macos' }, { sequence: 0 }, { version: '../escape' }, { size: 200 * 1024 * 1024 }]) {
    assert.throws(() => verifyRelease(envelope(release(invalid)), publicKey), /incompatible/)
  }
  assert.throws(() => verifyRelease(envelope(release({ url: 'http://updates.example/a' })), publicKey), /HTTPS/)
})
test('valid update downloads, checks, stages and schedules activation; credentials remain untouched', async t => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.root, 'private'))
  fs.writeFileSync(path.join(f.root, 'private/identity'), 'device-secret')
  const statuses = []
  const status = await f.service.update(s => statuses.push(s))
  assert.equal(status.state, 'installing')
  assert.deepEqual(f.commands.map(c => c.action), ['stage', 'schedule'])
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'pending-update.json'))).candidate, f.candidate)
  assert.equal(fs.readFileSync(path.join(f.root, 'private/identity'), 'utf8'), 'device-secret')
  assert.equal(statuses[0].state, 'pulling')
})
test('automatic update defers without downloading during a live CarPlay session', async t => {
  const f = fixture(t, { busy: async () => true })
  assert.equal((await f.service.update(() => {}, true)).state, 'idle')
  assert.equal(f.requests.length, 1)
  assert.equal(f.commands.length, 0)
  assert.ok(!fs.existsSync(path.join(f.root, 'pending-update.json')))
})
test('phone connecting during staging defers activation', async t => {
  let calls = 0
  const f = fixture(t, { busy: async () => ++calls > 1 })
  assert.equal((await f.service.update(() => {}, true)).state, 'idle')
  assert.deepEqual(f.commands.map(c => c.action), ['stage'])
  assert.ok(!fs.existsSync(f.candidate))
})
test('checksum mismatch never stages or schedules an update', async t => {
  const f = fixture(t, { fetch: async url => url.endsWith('.json')
    ? new Response(JSON.stringify(envelope(release()))) : new Response(Buffer.alloc(bytes.length)) })
  assert.match((await f.service.update(() => {})).message, /checksum/)
  assert.equal(f.commands.length, 0)
})
test('same installed version is skipped and older signed releases are rejected', async t => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.root, 'current'))
  fs.writeFileSync(path.join(f.root, 'current/release.json'), JSON.stringify({ version: 'v3-test', sequence: 100 }))
  assert.equal((await f.service.update(() => {})).state, 'no-update')
  fs.writeFileSync(path.join(f.root, 'current/release.json'), JSON.stringify({ version: 'v3-newer', sequence: 101 }))
  assert.match((await f.service.update(() => {})).message, /older/)
  assert.equal(f.commands.length, 0)
})
test('failed candidate health check does not schedule activation or hide the error behind an old result', async t => {
  const f = fixture(t, { command: async () => { throw new Error('Candidate failed health check') } })
  fs.writeFileSync(path.join(f.root, 'update-result.json'), JSON.stringify({ state: 'success', message: 'old success' }))
  assert.equal((await f.service.update(() => {})).state, 'error')
  assert.match(f.service.getStatus().message, /failed health check/)
  assert.ok(!fs.existsSync(path.join(f.root, 'pending-update.json')))
})
test('automatic updates do not repeatedly install a known failed version', async t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.root, 'update-result.json'), JSON.stringify({ state: 'error', failedVersion: 'v3-test', message: 'rolled back' }))
  assert.match((await f.service.update(() => {}, true)).message, /previous update failed/)
  assert.equal(f.commands.length, 0)
})
