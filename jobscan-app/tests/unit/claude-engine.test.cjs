// The Claude engine: each AI call is one isolated `claude -p` run of the
// user's own Claude Code, driven here through a stand-in (fixtures/fake-claude.cjs).
//
// What must hold: the worker gets the exact prompt text Codex gets, and
// nothing else -- no tools, no MCP servers, none of the user's settings or
// hooks, no @file expansion, no parent-session variables, no API key; its
// failures read to the loop like Codex's (a limit or a dead process is not
// the job's fault, a timeout is retried); and cancel ends calls at once.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const unit = path.join(__dirname, '..', '..', 'out', 'unit', 'electron')
const cli = require(path.join(unit, 'claude-cli.js'))
const { createClaudeEngine, CANCELED, NOT_FOUND } = require(path.join(unit, 'claude-engine.js'))
const { isCodexLimit, isCodexFailure } = require(path.join(unit, 'loop-policy.js'))

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.cjs')

function setup(extraEnv = {}, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-engine-'))
  const log = path.join(root, 'calls.jsonl')
  const work = path.join(root, 'claude-worker')
  const env = {
    ...process.env,
    FAKE_CLAUDE_LOG: log,
    // A parent Claude Code session's variables and an API key, which must not pass on.
    CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'parent', CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
    ANTHROPIC_API_KEY: 'sk-test', CLAUDE_CONFIG_DIR: path.join(root, 'cfg'), CLAUDE_CODE_USE_BEDROCK: '1',
    ...extraEnv,
  }
  const calls = []
  const engine = createClaudeEngine({
    binary: () => FAKE, model: () => opts.model ?? '', workDir: () => work,
    env: () => env, timeoutMs: opts.timeoutMs, onCall: info => calls.push(info),
  })
  const logged = () => fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  return { engine, logged, work, calls }
}

const call = (over = {}) => ({ kind: 'rating', system: 'SYSTEM TEXT', user: 'USER TEXT', ...over })

test('the worker runs isolated and gets exactly the text Codex gets', async () => {
  const { engine, logged, work } = setup({ FAKE_CLAUDE_MODE: 'echo' })
  fs.mkdirSync(work, { recursive: true })
  fs.writeFileSync(path.join(work, 'left-over.txt'), 'from a previous run')
  const reply = await engine.complete(call())
  assert.equal(reply, 'SYSTEM TEXT\n\n---\n\nUSER TEXT')
  const [run] = logged()
  for (const flag of ['-p', '--strict-mcp-config', '--no-session-persistence', '--no-chrome']) {
    assert.ok(run.argv.includes(flag), flag)
  }
  const after = (f) => run.argv[run.argv.indexOf(f) + 1]
  assert.equal(after('--tools'), '', 'no tools at all')
  assert.equal(after('--setting-sources'), 'project')
  assert.equal(after('--max-turns'), '1')
  assert.equal(after('--permission-mode'), 'dontAsk')
  assert.equal(after('--disallowedTools'), 'mcp__*')
  assert.equal(after('--output-format'), 'json')
  assert.equal(after('--system-prompt'), cli.WORKER_SYSTEM)
  assert.ok(!run.argv.includes('--model'), 'default model when none is set')
  assert.equal(run.env.CLAUDE_CODE_DISABLE_ATTACHMENTS, '1', '@file expansion off')
  assert.equal(run.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false')
  assert.equal(run.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1')
  assert.equal(run.env.DISABLE_AUTOUPDATER, '1')
  for (const gone of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_TOKEN', 'ANTHROPIC_API_KEY']) {
    assert.equal(run.env[gone], undefined, gone)
  }
  assert.ok(run.env.CLAUDE_CONFIG_DIR, 'the login location passes through')
  assert.equal(run.env.CLAUDE_CODE_USE_BEDROCK, '1', 'provider settings pass through')
  assert.deepEqual(run.cwdEntries, [], 'the working folder is emptied before each run')
})

test('a chosen model is passed, and is what the caches hash', async () => {
  const { engine, logged } = setup({}, { model: 'sonnet' })
  await engine.complete(call())
  const argv = logged()[0].argv
  assert.equal(argv[argv.indexOf('--model') + 1], 'sonnet')
  assert.equal(engine.hashModel(), 'claude:sonnet')
  assert.equal(setup().engine.hashModel(), 'claude:default')
})

test('noise before the JSON line is ignored; the reply is the result text', async () => {
  const { engine, calls } = setup({ FAKE_CLAUDE_MODE: 'noise', FAKE_CLAUDE_REPLY: '[{"job_id":"1"}]' })
  assert.equal(await engine.complete(call()), '[{"job_id":"1"}]')
  assert.equal(calls[0].outcome, 'ok')
  assert.ok(calls[0].usage && calls[0].usage.output === 10)
})

test('signed out: reported as Claude said it, not the job\'s fault, and the engine is not ready', async () => {
  const { engine } = setup({ FAKE_CLAUDE_MODE: 'not-logged-in', FAKE_CLAUDE_LOGGED_IN: '1' })
  await assert.rejects(engine.complete(call()), e => {
    assert.equal(e.message, 'Claude: Not logged in · Please run /login')
    assert.equal(isCodexFailure(`Error: ${e.message}`), true)
    return true
  })
  assert.equal(await engine.ready(), false, 'the failed call outranks a cached status')
})

test('a usage limit reads as a limit to the loop', async () => {
  const { engine } = setup({ FAKE_CLAUDE_MODE: 'limit' })
  await assert.rejects(engine.complete(call()), e => {
    assert.equal(isCodexLimit(`error Error: ${e.message}`), true)
    return true
  })
})

test('a process that dies without a reply is "Claude exited", not the job\'s fault', async () => {
  const { engine, calls } = setup({ FAKE_CLAUDE_MODE: 'crash' })
  await assert.rejects(engine.complete(call()), e => {
    assert.match(e.message, /^Claude exited \(code=3/)
    assert.equal(isCodexFailure(`Search generation failed: Error: ${e.message}`), true)
    return true
  })
  assert.equal(calls[0].outcome, 'exited')
})

test('a timeout is retried like a Codex turn timeout, not excused', async () => {
  const { engine, calls } = setup({ FAKE_CLAUDE_MODE: 'slow', FAKE_CLAUDE_SLEEP_MS: '20000' }, { timeoutMs: 400 })
  await assert.rejects(engine.complete(call()), e => {
    assert.match(e.message, /^Claude: no reply within/)
    assert.equal(isCodexFailure(e.message), false)
    return true
  })
  assert.equal(calls[0].outcome, 'timeout')
})

test('cancelling an owner ends its calls at once, and its later calls never start', async () => {
  const { engine, logged } = setup({ FAKE_CLAUDE_MODE: 'slow', FAKE_CLAUDE_SLEEP_MS: '20000' })
  const owner = { canceled: false }
  const pending = engine.complete(call({ owner }))
  await new Promise(r => setTimeout(r, 300))
  const t0 = Date.now()
  engine.cancelOwner(owner)
  await assert.rejects(pending, new RegExp(CANCELED))
  assert.ok(Date.now() - t0 < 5000, 'not after the 20 s reply')
  const before = logged().length
  await assert.rejects(engine.complete(call({ owner })), new RegExp(CANCELED))
  await assert.rejects(engine.complete(call({ owner: { canceled: true } })), new RegExp(CANCELED))
  assert.equal(logged().length, before, 'no process started for a canceled owner')
})

test('cancelAll ends every call in flight; later calls still work', async () => {
  const { engine } = setup({ FAKE_CLAUDE_MODE: 'slow', FAKE_CLAUDE_SLEEP_MS: '20000' })
  const pending = engine.complete(call({ owner: {} }))
  await new Promise(r => setTimeout(r, 300))
  await engine.cancelAll('test')
  await assert.rejects(pending, new RegExp(CANCELED))
})

test('ready() is the sign-in status, and no Claude Code means not ready', async () => {
  assert.equal(await setup({ FAKE_CLAUDE_LOGGED_IN: '1' }).engine.ready(), true)
  assert.equal(await setup({ FAKE_CLAUDE_LOGGED_IN: '0' }).engine.ready(), false)
  const missing = createClaudeEngine({ binary: () => null, model: () => '', workDir: () => os.tmpdir() })
  assert.equal(await missing.ready(), false)
  await assert.rejects(missing.complete(call()), e => {
    assert.equal(e.message, NOT_FOUND)
    assert.equal(isCodexFailure(e.message), true)
    return true
  })
  assert.equal(await missing.limits(), null)
})

test('the reply parser takes the last result line and reports errors and silent exits', () => {
  assert.deepEqual(cli.parseClaudeOutput('', 1, null), { kind: 'exited', message: 'Claude exited (code=1, signal=null) without a reply' })
  assert.deepEqual(cli.parseClaudeOutput('{"type":"result","is_error":true,"result":"Not logged in"}', 1, null),
    { kind: 'error', message: 'Not logged in' })
  const ok = cli.parseClaudeOutput('x\n{"type":"result","subtype":"success","is_error":false,"result":"hi"}\n', 0, null)
  assert.equal(ok.kind, 'ok')
  assert.equal(ok.text, 'hi')
})

test('scripts run on this runtime as Node; a native binary runs directly', () => {
  const env = { A: '1' }
  assert.deepEqual(cli.spawnSpecFor('C:/x/fake-claude.cjs', ['-p'], env, '/electron'),
    { command: '/electron', args: ['C:/x/fake-claude.cjs', '-p'], env: { A: '1', ELECTRON_RUN_AS_NODE: '1' } })
  assert.deepEqual(cli.spawnSpecFor('C:/x/claude.exe', ['-p'], env, '/electron'),
    { command: 'C:/x/claude.exe', args: ['-p'], env })
})

test('finding Claude Code: tests only use the stand-in; otherwise setting, known places, PATH, npm', () => {
  const files = new Set()
  const base = { setting: '', platform: 'win32', homedir: 'C:/Users/u', exists: p => files.has(p.replace(/\\/g, '/')), readFile: () => '{}' }
  const r = (o) => cli.resolveClaudeBinary({ ...base, ...o })
  files.add('C:/Users/u/.local/bin/claude.exe')
  assert.equal(r({ env: { E2E_TEST: '1' } }), null, 'under E2E_TEST nothing else is found')
  files.add('C:/fake/fake-claude.cjs')
  assert.equal(r({ env: { E2E_TEST: '1', JOBSCAN_CLAUDE_BIN: 'C:/fake/fake-claude.cjs' } }), 'C:/fake/fake-claude.cjs')
  assert.equal(r({ env: {} }).replace(/\\/g, '/'), 'C:/Users/u/.local/bin/claude.exe')
  files.add('D:/tools/claude.exe')
  assert.equal(r({ env: {}, setting: 'D:/tools/claude.exe' }), 'D:/tools/claude.exe', 'the Settings path wins')
  files.delete('C:/Users/u/.local/bin/claude.exe')
  files.add('E:/bin/claude.exe')
  assert.equal(r({ env: { PATH: 'C:/nothing;E:/bin' } }).replace(/\\/g, '/'), 'E:/bin/claude.exe')
  files.delete('E:/bin/claude.exe')
  files.add('C:/AppData/npm/node_modules/@anthropic-ai/claude-code/package.json')
  files.add('C:/AppData/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe')
  const npm = r({ env: { APPDATA: 'C:/AppData' }, readFile: () => JSON.stringify({ bin: { claude: 'bin/claude.exe' } }) })
  assert.equal(npm.replace(/\\/g, '/'), 'C:/AppData/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe')
  assert.equal(r({ env: { PATH: 'C:/AppData/npm' } }), null, 'a .cmd shim alone is never used')
})
