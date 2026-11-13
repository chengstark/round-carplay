const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const ts = require('typescript')
const filename = path.resolve('src/renderer/src/playport/appLaunch.ts')
const m = new Module(filename, module)
m._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, filename)
const { AppLaunch } = m.exports

function setup(t, timeout = 1000) {
  const states = [], sent = [], refreshes = []
  const launcher = new AppLaunch((app, requestId) => { sent.push({ app, requestId }); return true },
    () => refreshes.push(true), state => states.push(state), timeout)
  t.after(() => launcher.cancel())
  return { launcher, sent, states, refreshes, reply: (index, state = 'accepted') =>
    launcher.reply({ ...sent[index], state, message: 'Rejected' }) }
}

test('old frames cannot reveal a panel; a matching accepted reply requires refreshed video', t => {
  const c = setup(t)
  c.launcher.open('phone'); c.launcher.frame()
  assert.equal(c.states.at(-1).state, 'requesting')
  c.reply(0)
  assert.equal(c.refreshes.length, 1)
  assert.equal(c.states.at(-1).state, 'accepted')
  c.launcher.frame()
  assert.equal(c.states.at(-1).state, 'displaying')
})

test('rapid Music/Phone changes ignore old replies and reopening always requests the app', t => {
  const c = setup(t)
  c.launcher.open('youtube-music'); c.launcher.open('phone')
  c.reply(0); c.launcher.frame()
  assert.equal(c.states.at(-1).state, 'requesting')
  c.reply(1); c.launcher.frame(); c.launcher.cancel()
  c.launcher.open('phone')
  assert.equal(c.sent.length, 3)
  assert.notEqual(c.sent[1].requestId, c.sent[2].requestId)
  assert.equal(c.states.at(-1).state, 'requesting')
})

test('a rejected launch cannot become visible when video arrives', t => {
  const c = setup(t)
  c.launcher.open('phone'); c.reply(0, 'error'); c.launcher.frame()
  assert.equal(c.states.at(-1).state, 'error')
  assert.equal(c.refreshes.length, 0)
})

test('timeouts fail honestly and ignore late acceptance; reconnect cancels old launches', async t => {
  const c = setup(t, 10)
  c.launcher.open('phone')
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(c.states.at(-1).state, 'error')
  c.reply(0); c.launcher.frame()
  assert.equal(c.states.at(-1).state, 'error')
  c.launcher.open('phone'); c.launcher.cancel(); c.reply(1); c.launcher.frame()
  assert.equal(c.states.at(-1).state, 'idle')
})
