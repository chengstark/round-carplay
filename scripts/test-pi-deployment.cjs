// Exercise the packaged backend without node_modules or any attached hardware.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { io } = require('socket.io-client')
const { WebSocket, WebSocketServer } = require('ws')

test('Pi package owns the complete first-pair and reconnect Bluetooth flow', () => {
  const bridgePath = path.resolve('deploy/pi/experiments/native-inbound/bridge.rs')
  const bridge = readFileSync(bridgePath, 'utf8')
  const launcher = readFileSync('deploy/pi/launch.py', 'utf8')
  const installer = readFileSync('deploy/pi/install.sh', 'utf8')
  const diagnostics = readFileSync('deploy/pi/diagnose-connection.py', 'utf8')
  const packageScript = readFileSync('scripts/package-pi.mjs', 'utf8')
  const supervisorPatch = readFileSync(
    'deploy/pi/playport-patches/0001-persistent-bluetooth-bootstrap.patch',
    'utf8',
  )

  assert.match(launcher, /playport\/linux\/bt-bridge\/bt-bridge/)
  assert.match(installer, /python3-dbus python3-gi/)
  assert.match(launcher, /subprocess.Popen.*phone.py/)
  assert.match(installer, /diagnose-connection\.py/)
  assert.match(bridge, /00000000_deca_fade_deca_deafdecacafe/)
  assert.match(bridge, /decacaff/)
  assert.match(bridge, /Role::Client/)
  assert.match(bridge, /device.connect_profile/)
  assert.match(diagnostics, /iAP transport/)
  assert.match(diagnostics, /Wi-Fi handoff/)
  assert.match(diagnostics, /127\.0\.0\.1:8080\/api\/status/)
  assert.match(diagnostics, /get\('sessionActive'\) is True/)
  assert.match(packageScript, /deploy\/pi\/playport-patches/)
  assert.match(packageScript, /deploy\/pi\/experiments\/native-inbound/)
  assert.match(readFileSync('.github/workflows/pi-v3.yml', 'utf8'), /native-inbound\/\{bridge,pairing,main,cli\}\.rs/)
  assert.match(supervisorPatch, /return !bootstrapRunning \|\| sessionEndedSinceBootstrap/)
  assert.doesNotMatch(supervisorPatch, /^\+.*elapsedMillis >= 90_000L/m)
})

async function freePort() {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

test('standalone Pi backend: current UI/settings, authenticated PlayPort bridge, no legacy runtime', { timeout: 30_000 }, async t => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'round-pi-test-'))
  t.after(() => rmSync(temporary, { recursive: true, force: true }))
  const backend = path.join(temporary, 'backend.cjs')
  execFileSync(path.resolve('node_modules/.bin/esbuild'), ['src/backend/index.ts', '--bundle', '--platform=node',
    '--format=cjs', '--target=node20', '--external:bufferutil', '--external:utf-8-validate', `--outfile=${backend}`])
  const code = readFileSync(backend, 'utf8')
  assert.doesNotMatch(code, /require\(["'](?:usb|electron)["']\)/)
  assert.doesNotMatch(code, /disableLocalBluetooth|rfkill|AutoStartIfNeeded/)
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  t.after(() => { for (const c of upstream.clients) c.terminate(); upstream.close() })
  await new Promise(resolve => upstream.once('listening', resolve))
  const token = 'test-private-token'
  let authenticated = false
  upstream.on('connection', (socket, request) => {
    authenticated = request.url === '/ws?token=' + token
    socket.send(JSON.stringify({ type: 'status', sessionActive: true }))
    socket.on('message', (data, binary) => socket.send(data, { binary }))
  })
  const ui = path.join(temporary, 'ui')
  mkdirSync(ui)
  writeFileSync(path.join(ui, 'index.html'), '<title>current-round-dashboard</title>')
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const cursorRefresh = path.join(temporary, 'cursor-refresh')
  writeFileSync(cursorRefresh, '')
  const child = spawn(process.execPath, [backend], { cwd: temporary, env: {
    ...process.env, HOME: temporary, ROUND_CARPLAY_PORT: String(port), ROUND_CARPLAY_DEPLOYMENT: 'playport-pi',
    ROUND_CARPLAY_DATA_DIR: path.join(temporary, 'data'), ROUND_CARPLAY_UI_DIR: ui,
    PLAYPORT_WS_URL: `ws://127.0.0.1:${upstream.address().port}/ws?token=${token}`,
    ROUND_CARPLAY_CURSOR_REFRESH_PATH: cursorRefresh
  }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', d => { output += d })
  child.stderr.on('data', d => { output += d })
  t.after(async () => {
    if (child.exitCode !== null) return
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
  })
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(base + '/health')).ok) break } catch {}
    if (attempt > 100 || child.exitCode !== null) assert.fail('Backend failed to start: ' + output)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const health = await (await fetch(base + '/health')).json()
  assert.equal(health.runtime, 'browser')
  assert.equal(health.playportConfigured, true)
  assert.equal((await fetch(base + '/api/developer/pointer-refresh', { method: 'POST', headers: { Origin: 'https://untrusted.example' } })).status, 403)
  assert.equal((await fetch(base + '/api/developer/pointer-refresh', { method: 'POST', headers: { Origin: base } })).status, 204)
  assert.match(readFileSync(cursorRefresh, 'utf8'), /^\d+$/)
  assert.ok(!JSON.stringify(health).includes(token))
  assert.match(await (await fetch(base)).text(), /current-round-dashboard/)
  const phoneState = path.join(temporary, '.local/share/round-carplay-pi/state')
  mkdirSync(phoneState, { recursive: true })
  writeFileSync(path.join(phoneState, 'phone.json'), JSON.stringify({ state: 'pairing', message: 'Approve on phone', code: '001234' }))
  assert.equal((await (await fetch(base + '/api/phone')).json()).code, '001234')
  assert.equal((await fetch(base + '/api/phone', { method: 'POST', headers: { Origin: 'https://untrusted.example' } })).status, 403)
  await fetch(base + '/api/phone', { method: 'POST', headers: { Origin: base } })
  assert.equal(require('node:fs').existsSync(path.join(phoneState, 'phone-pair-request')), false, 'Do not queue a second pairing while active')
  writeFileSync(path.join(phoneState, 'phone.json'), JSON.stringify({ state: 'connecting', message: 'Connecting using saved pairing' }))
  await fetch(base + '/api/phone', { method: 'POST', headers: { Origin: base } })
  assert.equal(require('node:fs').existsSync(path.join(phoneState, 'phone-pair-request')), false, 'Do not queue another operation while connecting')
  writeFileSync(path.join(phoneState, 'phone.json'), JSON.stringify({ state: 'idle', message: 'Tap Pair iPhone' }))
  assert.equal((await fetch(base + '/api/phone', { method: 'POST', headers: { Origin: base } })).status, 200)
  assert.ok(statSync(path.join(phoneState, 'phone-pair-request')).isFile())
  const socket = io(base, { transports: ['websocket'], extraHeaders: { Origin: base } })
  t.after(() => socket.disconnect())
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject) })
  const rpc = (method, ...args) => new Promise(resolve => socket.emit('rpc', { method, args }, resolve))
  const settings = await rpc('settings.get')
  assert.equal(settings.ok, true)
  assert.equal((await rpc('settings.save', { ...settings.value, backgroundColor: '#123456' })).ok, true)
  assert.equal(JSON.parse(readFileSync(path.join(temporary, 'data/config.json'))).backgroundColor, '#123456')
  for (const method of ['carplay.start', 'usb.forceReset', 'bluetooth.connect', 'runtime.switchTo']) {
    assert.equal((await rpc(method)).ok, false, method + ' must not invoke an obsolete runtime')
  }
  const update = await rpc('update.start')
  assert.equal(update.value.state, 'error')
  assert.match(update.value.message, /update feed/)
  const bridge = new WebSocket(`ws://127.0.0.1:${port}/playport`, { origin: base })
  t.after(() => bridge.terminate())
  await new Promise((resolve, reject) => {
    const onStatus = (data, binary) => {
      if (!binary && JSON.parse(data.toString()).type === 'status') {
        bridge.off('message', onStatus)
        resolve()
      }
    }
    bridge.on('message', onStatus)
    bridge.once('error', reject)
  })
  assert.equal(authenticated, true)
  const reply = new Promise(resolve => bridge.once('message', (data, binary) => resolve({ data, binary })))
  bridge.send(Buffer.from([0, 1, 2, 255]))
  const echoed = await reply
  assert.equal(echoed.binary, true)
  assert.deepEqual(echoed.data, Buffer.from([0, 1, 2, 255]))
  const forbidden = new WebSocket(`ws://127.0.0.1:${port}/playport`, { origin: 'https://untrusted.example' })
  const status = await new Promise(resolve => {
    forbidden.on('unexpected-response', (_request, response) => { response.resume(); forbidden.terminate(); resolve(response.statusCode) })
    forbidden.on('error', () => {})
  })
  assert.equal(status, 403)
})
