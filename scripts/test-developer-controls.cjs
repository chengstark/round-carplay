const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')

test('pointer defaults hidden, developer switch enables it, and disabling clears the saved override', () => {
  const styles = new Map(), stored = new Map(), exports = {}, refreshes = []
  const context = {
    exports,
    setTimeout: () => 1,
    clearTimeout: () => {},
    fetch: (url, options) => { refreshes.push({ url, method: options.method }); return Promise.resolve({}) },
    document: {
      getElementById: id => styles.get(id),
      createElement: () => ({ id: '', textContent: '' }),
      head: { appendChild: style => styles.set(style.id, style) }
    },
    localStorage: {
      getItem: key => stored.get(key) || null,
      setItem: (key, value) => stored.set(key, value)
    }
  }
  const source = ts.transpileModule(fs.readFileSync('src/renderer/src/developerControls.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  vm.runInNewContext(source, context)
  exports.applyDeveloperControls()
  assert.equal(refreshes[0].url, '/api/developer/pointer-refresh')
  const style = styles.get('pi-hide-cursor')
  assert.match(style.textContent, /cursor:none!important/)
  exports.saveDeveloperControls({ enabled: true, showMousePointer: true })
  assert.equal(refreshes.length, 2, 'a cursor visibility change refreshes compositor pointer focus')
  assert.equal(style.textContent, '')
  exports.applyDeveloperControls()
  assert.equal(style.textContent, '', 'saved pointer preference survives initialization')
  exports.saveDeveloperControls({ enabled: false, showMousePointer: true })
  assert.match(style.textContent, /cursor:none!important/)
  assert.equal(exports.readDeveloperControls().showMousePointer, false)
  stored.set('round-carplay-developer-controls', 'invalid')
  exports.applyDeveloperControls()
  assert.match(style.textContent, /cursor:none!important/)
})

test('startup and restored focus refresh the cursor after Chromium is ready, with bounded retries', () => {
  const exports = {}, timers = new Map(), listeners = new Map(), styles = new Map()
  let serial = 0, refreshes = 0
  const context = {
    exports,
    fetch: () => { refreshes++; return Promise.resolve({}) },
    setTimeout: (callback, delay) => { const id = ++serial; timers.set(id, { callback, delay }); return id },
    clearTimeout: id => timers.delete(id),
    window: { addEventListener: (name, callback) => listeners.set(name, callback) },
    document: {
      visibilityState: 'visible',
      addEventListener: (name, callback) => listeners.set(name, callback),
      getElementById: id => styles.get(id),
      createElement: () => ({ id: '', textContent: '' }),
      head: { appendChild: style => styles.set(style.id, style) }
    },
    localStorage: { getItem: () => null, setItem: () => {} }
  }
  const source = ts.transpileModule(fs.readFileSync('src/renderer/src/developerControls.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  vm.runInNewContext(source, context)
  exports.applyDeveloperControls()
  assert.equal(refreshes, 1)
  assert.equal(timers.size, 4)
  assert.ok(Math.max(...[...timers.values()].map(timer => timer.delay)) >= 10000)
  for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback() }
  assert.equal(refreshes, 5, 'late compositor focus gets a refresh after the first early attempt')
  assert.equal(timers.size, 0, 'retries finish instead of generating continuous pointer motion')
  listeners.get('focus')()
  listeners.get('pageshow')()
  assert.equal(timers.size, 4, 'overlapping lifecycle events replace pending retries')
  exports.saveDeveloperControls({ enabled: true, showMousePointer: true })
  listeners.get('load')()
  assert.equal(styles.get('pi-hide-cursor').textContent, '', 'focus refresh preserves the visible pointer override')
  context.document.visibilityState = 'hidden'
  const before = refreshes
  listeners.get('visibilitychange')()
  assert.equal(refreshes, before)
  context.document.visibilityState = 'visible'
  listeners.get('visibilitychange')()
  assert.equal(refreshes, before + 1)
})
