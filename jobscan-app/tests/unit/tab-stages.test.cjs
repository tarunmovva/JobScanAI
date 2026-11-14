// The tab legend must say what the tabs actually say.
//
// Python writes the labels (job_application_automator/tab_tag.py STAGES); this
// app only explains them (electron/tab-stages.ts). Two hand-maintained copies
// of the same vocabulary drift, and a legend that disagrees with the tab strip
// is worse than no legend -- the user trusts it and misreads the tabs.
//
// So this reads BOTH files and compares them. It parses the Python source
// rather than importing it, so the check costs nothing and runs on a machine
// without the automator installed.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { TAB_STAGES, TAB_STAGE_ORDER } = require(
  path.join(__dirname, '..', '..', 'out', 'unit', 'electron', 'tab-stages.js'))

// Same sibling-checkout derivation the other cross-repo tests use.
function tabTagPy() {
  return path.resolve(__dirname, '..', '..', '..', 'jobscan',
    'job_application_automator', 'tab_tag.py')
}

// "extract": {"code": "EXTR", "color": "#6b7280", "meaning": "Reading the form"},
function parsePythonStages(src) {
  const body = src.slice(src.indexOf('STAGES: dict'), src.indexOf('DEFAULT_STAGE'))
  const out = {}
  const row = /"(\w+)":\s*\{"code":\s*"([^"]+)",\s*"color":\s*"([^"]+)",\s*"meaning":\s*"([^"]*)"\}/g
  let m
  while ((m = row.exec(body)) !== null) {
    // Python escapes the em dash as — in source; compare the real char.
    out[m[1]] = { code: m[2], color: m[3], meaning: m[4].replace(/\\u2014/g, '—') }
  }
  return out
}

test('the legend lists exactly the stages Python can write', (t) => {
  const py = tabTagPy()
  if (!fs.existsSync(py)) return t.skip('automator checkout not present')

  const stages = parsePythonStages(fs.readFileSync(py, 'utf-8'))
  assert.ok(Object.keys(stages).length >= 6, 'failed to parse tab_tag.py STAGES')
  assert.deepEqual(Object.keys(TAB_STAGES).sort(), Object.keys(stages).sort())
})

test('every code, colour and meaning matches the Python source', (t) => {
  const py = tabTagPy()
  if (!fs.existsSync(py)) return t.skip('automator checkout not present')

  const stages = parsePythonStages(fs.readFileSync(py, 'utf-8'))
  for (const [name, spec] of Object.entries(stages)) {
    assert.equal(TAB_STAGES[name].code, spec.code, `${name} code`)
    assert.equal(TAB_STAGES[name].color, spec.color, `${name} colour`)
    assert.equal(TAB_STAGES[name].meaning, spec.meaning, `${name} meaning`)
  }
})

test('the legend renders every stage exactly once', () => {
  // A stage missing from the order is a colour in the tab strip with nothing
  // explaining it; a duplicate is a legend that looks broken.
  assert.deepEqual([...TAB_STAGE_ORDER].sort(), Object.keys(TAB_STAGES).sort())
  assert.equal(new Set(TAB_STAGE_ORDER).size, TAB_STAGE_ORDER.length)
})

test('codes are four characters, so the tab strip stays aligned', () => {
  for (const [name, spec] of Object.entries(TAB_STAGES)) {
    assert.equal(spec.code.length, 4, `${name} is "${spec.code}"`)
  }
})

test('no meaning is left blank', () => {
  // The whole point of the legend is that a four-letter code is undecodable.
  for (const [name, spec] of Object.entries(TAB_STAGES)) {
    assert.ok(spec.meaning.trim().length > 0, name)
    assert.match(spec.color, /^#[0-9a-f]{6}$/, name)
  }
})

test('the stages a user must act on are visually distinct', () => {
  // "needs you" is the only one asking for a person. If it shared a colour
  // with an ordinary failure the legend would be decorative.
  const colors = Object.values(TAB_STAGES).map(s => s.color)
  assert.equal(new Set(colors).size, colors.length, 'two stages share a colour')
  assert.notEqual(TAB_STAGES.needs.color, TAB_STAGES.failed.color)
})
