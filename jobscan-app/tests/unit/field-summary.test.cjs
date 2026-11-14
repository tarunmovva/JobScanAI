// Regression test for the "school not in the sample → American University" bug.
//
// The payload agent picks dropdown answers from the JSON this helper produces.
// The Greenhouse extractor caps option collection at 80, which turns a School
// typeahead into an alphabetical A-only sample and marks it options_truncated.
// The old summary dropped that flag, so PAYLOAD_SYSTEM rule 3's typeahead
// EXCEPTION was unreachable and the agent "picked the closest listed option".
//
// Fixture is a real capture of a Greenhouse form, trimmed to three dropdowns.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs')

const { summarizeFieldsForPrompt } = require('../../out/unit/electron/field-summary.js')

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'greenhouse-school-typeahead.fields.json'), 'utf-8'))

const summary = summarizeFieldsForPrompt(fixture.fields)
const byId = Object.fromEntries(summary.map(f => [f.id, f]))

test('truncated typeahead keeps its options_truncated flag (School)', () => {
  const school = byId['school--0']
  assert.equal(school.options_truncated, true,
    'School is the field that produced "American University" 58 times without this flag')
  // The sample really is alphabetically degenerate — that is why the flag matters.
  assert.equal(school.options.length, 80)
  assert.ok(school.options.every(t => t.toUpperCase().startsWith('A')))
  assert.ok(!school.options.some(t => t.includes('Northbridge')))
})

test('truncated typeahead keeps its flag (Country) — the in-sample case', () => {
  const country = byId['country']
  assert.equal(country.options_truncated, true)
  // Correct answer IS in this sample, suffix and all. PAYLOAD_SYSTEM rule 3(a)
  // is what stops the agent from answering a bare "United States" here.
  assert.ok(country.options.includes('United States +1'))
})

test('non-truncated dropdown gains no flag (Discipline)', () => {
  const discipline = byId['discipline--0']
  assert.equal('options_truncated' in discipline, false,
    'a complete list must keep using the closest-option rule')
  assert.equal(discipline.options.length, 72)
})

test('flag is emitted before options so the caveat precedes the list', () => {
  const keys = Object.keys(byId['school--0'])
  assert.ok(keys.includes('options_truncated') && keys.includes('options'))
  assert.ok(keys.indexOf('options_truncated') < keys.indexOf('options'))
})

test('extractor hints that contradict the typeahead rule are not forwarded', () => {
  // options_note is "Select from the available options." and
  // supports_custom_input is false — both would fight the flag.
  for (const f of summary) {
    assert.equal('options_note' in f, false)
    assert.equal('supports_custom_input' in f, false)
    assert.equal('selector' in f, false)
    assert.equal('name' in f, false)
  }
})

test('option texts are byte-identical to the pre-fix summary', () => {
  // The old implementation, verbatim — the fix must add the flag and change
  // nothing else about what the agent sees.
  const legacy = fixture.fields.map(f => ({
    id: f.id, label: f.label, type: f.type, required: f.required,
    ...(f.options && f.options.length > 0
      ? { options: f.options.map(o => typeof o === 'string' ? o : (o['text'] || o['label'] || '')).filter(Boolean) }
      : {}),
  }))
  for (const [i, old] of legacy.entries()) {
    const now = { ...summary[i] }
    delete now.options_truncated
    assert.deepEqual(now, old)
  }
})
