// When a Codex version is broken for this app, and which one to use instead.
//
// Only a protocol failure -- Codex no longer speaks what this app speaks --
// may reject a version. Codex reports nearly every error as -32600, so the
// code alone says little: read off a real 0.153.4, a request it could not
// even parse (an unknown method, a parameter of the wrong type) reads
// "Invalid request: ...", while signed out, "Not initialized", "thread not
// found" and a broken config are -32600 too, without that prefix. Those, a
// usage limit, a withdrawn model, the network or a timeout say nothing about
// the version and must never reject it.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  rpcErrorCode, isProtocolError, pickManagedVersion, createStartupCrashCounter, CORE_METHODS,
} = require('../../out/unit/electron/codex-health.js')

const asClientError = e => new Error(JSON.stringify(e))   // what codex-client rejects with

test('the JSON-RPC error code is read from what the client rejects with', () => {
  assert.equal(rpcErrorCode(asClientError({ code: -32600, message: 'Not initialized' })), -32600)
  assert.equal(rpcErrorCode({ code: -32602, message: 'Invalid params' }), -32602)
  assert.equal(rpcErrorCode(new Error('Codex RPC timeout: turn/start')), null)
})

test('what a real Codex says when it does not understand the request is a protocol failure', () => {
  for (const e of [
    { code: -32600, message: 'Invalid request: unknown variant `thread/begin`, expected one of `initialize`, `thread/start`' },
    { code: -32600, message: 'Invalid request: invalid type: integer `12345`, expected a string' },
    { code: -32601, message: 'Method not found' },
    { code: -32700, message: 'Parse error' },
    { code: -32602, message: 'invalid params: missing field `threadId`' },
  ]) {
    assert.equal(isProtocolError(asClientError(e)), true, e.message)
    assert.equal(isProtocolError(e), true, 'as a raw error object: ' + e.message)
  }
  assert.equal(isProtocolError(new Error('Codex did not return thread id')), true)
  assert.equal(isProtocolError(new Error('Codex did not return turn id')), true)
})

test('what a real Codex says for ordinary failures never rejects a version', () => {
  for (const e of [
    { code: -32600, message: 'codex account authentication required to read rate limits' },
    { code: -32600, message: 'chatgpt authentication required to read rate limits' },
    { code: -32600, message: 'Not initialized' },
    { code: -32600, message: 'thread not found: 00000000-0000-0000-0000-000000000000' },
    { code: -32600, message: 'failed to load configuration: invalid TOML at line 3' },
    { code: -32602, message: 'input exceeds the maximum length of 1048576 characters', data: { input_error_code: 'input_too_large' } },
    { code: -32603, message: 'internal error' },
  ]) {
    assert.equal(isProtocolError(asClientError(e)), false, e.message)
  }
  for (const msg of [
    'Codex RPC timeout: turn/start',
    "Codex: 400 The 'gpt-x' model is not supported",
    'Codex: You have hit your usage limit',
    'Codex exited (code=1 signal=none)',
    'not logged in',
  ]) {
    assert.equal(isProtocolError(new Error(msg)), false, msg)
  }
})

test('the calls the app depends on are the ones that count', () => {
  assert.deepEqual([...CORE_METHODS].sort(),
    ['account/rateLimits/read', 'initialize', 'model/list', 'thread/start', 'turn/start'])
})

test('the newest version that was verified and never rejected is used', () => {
  assert.equal(pickManagedVersion(['0.170.0', '0.169.0', '0.168.0'], []), '0.170.0')
  assert.equal(pickManagedVersion(['0.170.0', '0.169.0', '0.168.0'], ['0.170.0']), '0.169.0')
  assert.equal(pickManagedVersion(['0.170.0', '0.169.0'], ['0.170.0', '0.169.0']), null, 'none left: the bundled one')
  assert.equal(pickManagedVersion([], []), null)
})

test('an app-server that dies before answering counts only the second time in a row', () => {
  const c = createStartupCrashCounter(2)
  assert.equal(c.crashed(), false)
  c.started()                          // it answered initialize: the count starts over
  assert.equal(c.crashed(), false)
  assert.equal(c.crashed(), true)
})
