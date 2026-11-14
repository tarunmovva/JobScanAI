// The thread/start and turn/start requests, built in one place.
//
// The update check runs one real turn with exactly what real runs send, so
// a Codex that would reject the app's real requests fails the check rather
// than every job afterwards. Pinned here so the two can never drift apart.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const { threadStartParams, turnStartParams, PROBE_TEXT } = require('../../out/unit/electron/codex-requests.js')

test('a thread is ephemeral, read-only, never asks for approval', () => {
  assert.deepEqual(threadStartParams({ cwd: '/work', model: 'gpt-cheap' }), {
    cwd: '/work', approvalPolicy: 'never', sandbox: 'read-only', personality: 'pragmatic', ephemeral: true, model: 'gpt-cheap',
  })
  assert.equal('model' in threadStartParams({ cwd: '/work' }), false, 'Auto sends no model')
})

test('a turn carries one text input at medium effort', () => {
  assert.deepEqual(turnStartParams({ threadId: 'th-1', text: 'hello', model: 'gpt-cheap' }), {
    threadId: 'th-1', effort: 'medium', summary: 'none', input: [{ type: 'text', text: 'hello' }], model: 'gpt-cheap',
  })
  assert.equal('model' in turnStartParams({ threadId: 'th-1', text: 'hello' }), false)
})

test('the check asks for one word', () => {
  assert.match(PROBE_TEXT, /single word/i)
})
