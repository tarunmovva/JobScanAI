// A stand-in `codex app-server` for the update-check tests: JSON-RPC over
// stdio, one JSON object per line. FAKE_MODE picks a way to misbehave;
// FAKE_LOG, when set, receives every request it was sent.
//
// The error replies copy what a real Codex (0.153.4) sends: everything is
// -32600, and only a request Codex could not even parse -- an unknown method,
// a parameter of the wrong type -- reads "Invalid request: ...". Signed out,
// "thread not found", a broken config: also -32600, without that prefix.
//
// `<fake> login status` answers like `codex login status`.
const fs = require('fs')
const readline = require('readline')

const mode = process.env.FAKE_MODE || 'ok'
const log = process.env.FAKE_LOG

if (process.argv[2] === 'login' && process.argv[3] === 'status') {
  if (mode === 'signed-out') { console.log('Not logged in'); process.exit(1) }
  console.log(mode === 'api-key' ? 'Logged in using an API key' : 'Logged in using ChatGPT')
  process.exit(0)
}
if (mode === 'crash') process.exit(3)

const send = o => process.stdout.write(JSON.stringify(o) + '\n')
let turns = 0
const notify = (method, params) => send({ jsonrpc: '2.0', method, params })
const unknownMethod = m => `Invalid request: unknown variant \`${m}\`, expected one of \`initialize\`, \`model/list\``

readline.createInterface({ input: process.stdin }).on('line', line => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (log) fs.appendFileSync(log, JSON.stringify({ method: m.method, params: m.params }) + '\n')
  if (m.id === undefined) return   // a notification
  const ok = result => send({ jsonrpc: '2.0', id: m.id, result })
  const err = (code, message, data) => send({ jsonrpc: '2.0', id: m.id, error: { code, message, ...(data ? { data } : {}) } })
  switch (m.method) {
    case 'initialize':
      return ok({ userAgent: 'fake-app-server' })
    case 'model/list':
      return ok({ data: [{ id: 'gpt-big' }, { id: 'gpt-cheap' }] })
    case 'account/rateLimits/read':
      if (mode === 'limits-unknown') return err(-32600, unknownMethod(m.method))
      if (mode === 'api-key') return err(-32600, 'chatgpt authentication required to read rate limits')
      if (mode === 'limits-unparseable') return ok({ something: 'else' })
      return ok({
        rateLimits: {
          primary: { usedPercent: mode === 'exhausted' ? 100 : 10, windowDurationMins: 300, resetsAt: 1 },
          secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 2 },
        },
      })
    case 'thread/start':
      if (mode === 'thread-unknown') return err(-32600, unknownMethod(m.method))
      if (mode === 'thread-bad-params') return err(-32600, 'Invalid request: invalid type: string "pragmatic", expected a boolean')
      return ok({ thread: { id: 'th-1' } })
    case 'turn/start':
      if (mode === 'turn-no-id') return ok({ turn: {} })
      if (mode === 'config-broken') return err(-32600, 'failed to load configuration: invalid TOML at line 3')
      if (mode === 'input-too-large') return err(-32602, 'input exceeds the maximum length of 1048576 characters', { input_error_code: 'input_too_large' })
      if (mode === 'burst') {
        // The reply, the streamed text and the completion in ONE write, so
        // they reach the client as one chunk. Three separate writes often do
        // too (macOS pipes are asynchronous); this makes it certain.
        return process.stdout.write([
          { jsonrpc: '2.0', id: m.id, result: { turn: { id: 'tu-1' } } },
          { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { turnId: 'tu-1', delta: 'OK' } },
          { jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: 'tu-1', status: 'completed' } } },
        ].map(o => JSON.stringify(o) + '\n').join(''))
      }
      if (mode === 'oracle') {
        // The end-to-end tests' shared answers (tests/fixtures/ai-oracle.cjs),
        // one turn id per turn so parallel turns stay apart.
        const id = `tu-${++turns}`
        const text = String(m.params?.input?.[0]?.text ?? '')
        if (process.env.FAKE_PROMPT_LOG) fs.appendFileSync(process.env.FAKE_PROMPT_LOG, JSON.stringify({ text }) + '\n')
        const reply = require(process.env.FAKE_ORACLE).answer(text)
        ok({ turn: { id } })
        notify('item/agentMessage/delta', { turnId: id, delta: reply })
        return notify('turn/completed', { turn: { id, status: 'completed' } })
      }
      ok({ turn: { id: 'tu-1' } })
      if (mode === 'no-complete') return
      notify('item/agentMessage/delta', { turnId: 'tu-1', delta: 'OK' })
      if (mode === 'turn-failed') {
        return notify('turn/completed', { turn: { id: 'tu-1', status: 'failed', error: { message: "400 The 'gpt-big' model is not supported" } } })
      }
      return notify('turn/completed', { turn: { id: 'tu-1', status: 'completed' } })
    default:
      return err(-32600, unknownMethod(m.method))
  }
})
