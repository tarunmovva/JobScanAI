// The check a downloaded Codex must pass before the app switches to it.
//
// It used to try only `initialize` and `model/list`. Every rating and every
// form answer also needs `thread/start`, `turn/start`, the streamed reply and
// `turn/completed`, and the loop reads the usage limits: a release that
// changed any of those passed the check and then failed every job. The check
// now runs one tiny real turn -- after reading the usage limits, so it never
// spends a limit that has run out.
//
// What a failure means matters: a PROTOCOL failure (the new Codex does not
// speak what this app speaks) rejects that version for good; anything else
// (signed out, usage limit, model gone, broken config, timeout) only defers.
// The fake app-server answers the way a real Codex does (see the fixture).
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { probeAppServer } = require('../../out/unit/electron/codex-probe.js')
const { PROBE_TEXT } = require('../../out/unit/electron/codex-requests.js')

const FAKE = path.join(__dirname, 'fixtures', 'fake-app-server.cjs')

async function probe(mode, opts = {}, command = process.execPath) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-probe-')), 'requests.jsonl')
  const env = { ...process.env, FAKE_MODE: mode, FAKE_LOG: log }
  const r = await probeAppServer(
    { command, args: [FAKE, 'app-server'], env, loginStatus: { command, args: [FAKE, 'login', 'status'] } },
    // Generous: a cold start on a slow CI runner took over 3 s for a full
    // turn. Only the test that expects a timeout passes a short one.
    { turn: true, savedModel: '', cwd: os.tmpdir(), timeoutMs: 15000, ...opts },
  )
  const sent = fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  return { r, sent }
}

test('a Codex that answers every call this app makes passes, turn and all', async () => {
  const { r, sent } = await probe('ok')
  assert.deepEqual(r.verdict, { kind: 'ok' })
  assert.equal(r.turnChecked, true)
  assert.deepEqual(r.ids, ['gpt-big', 'gpt-cheap'])
  assert.deepEqual(sent.map(s => s.method),
    ['initialize', 'initialized', 'model/list', 'account/rateLimits/read', 'thread/start', 'turn/start'])
  assert.equal(sent[5].params.input[0].text, PROBE_TEXT)
})

test('a turn that completes in the same chunk as its turn/start reply still passes', async () => {
  // Found on a macOS runner: the reply, the streamed text and turn/completed
  // arrived together, readline handed over all three lines before the turn
  // id was known, both notifications were dropped, and the check waited out
  // its whole timeout. Raising the timeout (once 3 s, now 15 s) never helped.
  const { r } = await probe('burst', { timeoutMs: 3000 })
  assert.deepEqual(r.verdict, { kind: 'ok' })
  assert.equal(r.turnChecked, true)
})

test('the check uses the model a real run would: the saved one when offered, else Auto', async () => {
  const saved = await probe('ok', { savedModel: 'gpt-cheap' })
  assert.equal(saved.r.model, 'gpt-cheap')
  assert.equal(saved.sent.find(s => s.method === 'thread/start').params.model, 'gpt-cheap')
  const auto = await probe('ok', { savedModel: 'gpt-withdrawn' })
  assert.equal(auto.r.model, 'gpt-big', 'Auto is the first listed')
})

test('a call this app needs that Codex no longer understands rejects the version', async () => {
  for (const mode of ['thread-unknown', 'thread-bad-params', 'limits-unknown']) {
    const { r } = await probe(mode)
    assert.equal(r.verdict.kind, 'protocol', mode)
  }
})

test('a turn started without an id rejects the version', async () => {
  const { r } = await probe('turn-no-id')
  assert.equal(r.verdict.kind, 'protocol')
})

test('an app-server that dies before it answers, twice, rejects the version', async () => {
  const { r } = await probe('crash')
  assert.equal(r.verdict.kind, 'protocol')
})

test('signed out, nothing is judged: the check waits for a sign-in', async () => {
  // Found in review: the check runs 5 s after launch, while a new user is
  // still on the sign-in screen, and Codex answers the limits read with
  // -32600 then. That must never reject a good version.
  const { r, sent } = await probe('signed-out')
  assert.equal(r.verdict.kind, 'inconclusive')
  assert.match(r.verdict.detail, /signed out/i)
  assert.deepEqual(sent, [], 'the app-server was started anyway')
})

test('with no usage limits to read (an API key), no turn is spent and the update is not held back', async () => {
  for (const mode of ['api-key', 'limits-unparseable']) {
    const { r, sent } = await probe(mode)
    assert.deepEqual(r.verdict, { kind: 'ok' }, mode)
    assert.equal(r.turnChecked, false, mode)
    assert.equal(sent.some(s => s.method === 'thread/start'), false, `${mode}: a turn was started without known limits`)
  }
})

test('a broken config or an oversized input is not the version\'s fault', async () => {
  for (const mode of ['config-broken', 'input-too-large']) {
    const { r } = await probe(mode)
    assert.equal(r.verdict.kind, 'inconclusive', mode)
  }
})

test('a usage limit that has run out defers the check, and no turn is spent', async () => {
  const { r, sent } = await probe('exhausted')
  assert.equal(r.verdict.kind, 'inconclusive')
  assert.match(r.verdict.detail, /usage limit/i)
  assert.equal(sent.some(s => s.method === 'thread/start'), false, 'a turn was started on an exhausted limit')
})

test('a turn the service failed, or one that never finished, defers instead of rejecting', async () => {
  const failed = await probe('turn-failed')
  assert.equal(failed.r.verdict.kind, 'inconclusive')
  const silent = await probe('no-complete', { timeoutMs: 800 })
  assert.equal(silent.r.verdict.kind, 'inconclusive')
})

test('a binary that cannot start at all (quarantined, deleted) defers instead of rejecting', async () => {
  const { r } = await probe('ok', {}, path.join(os.tmpdir(), 'no-such-codex-binary.exe'))
  assert.equal(r.verdict.kind, 'inconclusive')
})

test('without the turn, only the start and the model list are tried', async () => {
  const { r, sent } = await probe('ok', { turn: false })
  assert.deepEqual(r.verdict, { kind: 'ok' })
  assert.deepEqual(sent.map(s => s.method), ['initialize', 'initialized', 'model/list'])
})
