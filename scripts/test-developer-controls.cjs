const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')

test('pointer defaults hidden, developer switch enables it, and disabling clears the saved override', () => {
  const styles = new Map(), stored = new Map(), exports = {}
  const context = {
    exports,
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
  const style = styles.get('pi-hide-cursor')
  assert.match(style.textContent, /cursor:none!important/)
  exports.saveDeveloperControls({ enabled: true, showMousePointer: true })
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
