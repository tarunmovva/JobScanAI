// The AI engine seam: which engine answers, and what the cached stages hash.
//
// Routing the three AI calls through ai-engine.ts must change nothing for
// Codex users: the hash input stays the raw codexModel setting ('' for
// Auto), so no cached searches, ratings or payloads are invalidated.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const unit = path.join(__dirname, '..', '..', 'out', 'unit', 'electron')
const { engineIdFrom, codexHashModel, registerEngines, aiEngine, selectedEngineId } = require(path.join(unit, 'ai-engine.js'))

test('Codex hashes exactly what the stages always hashed', () => {
  // Before the seam: String(store.get('codexModel') ?? '') -- untrimmed.
  for (const stored of [undefined, null, '', 'gpt-5.5', ' gpt-5.5 ']) {
    assert.equal(codexHashModel(() => stored), String(stored ?? ''))
  }
})

test('only "claude" selects the Claude engine; anything else is Codex', () => {
  assert.equal(engineIdFrom('claude'), 'claude')
  for (const v of [undefined, null, '', 'codex', 'Claude', 1]) assert.equal(engineIdFrom(v), 'codex')
})

test('the selected engine answers, and Codex stands in when it is missing', () => {
  const codex = { id: 'codex' }
  const claude = { id: 'claude' }
  let setting = 'claude'
  registerEngines({ codex, claude }, () => setting)
  assert.equal(aiEngine(), claude)
  assert.equal(selectedEngineId(), 'claude')
  setting = undefined
  assert.equal(aiEngine(), codex)
  registerEngines({ codex }, () => 'claude')
  assert.equal(aiEngine(), codex, 'claude selected but not available')
  registerEngines({}, () => 'codex')
  assert.throws(() => aiEngine(), /not ready/)
})
