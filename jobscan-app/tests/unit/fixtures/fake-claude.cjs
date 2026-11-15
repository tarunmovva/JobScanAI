// A stand-in `claude` for the Claude-engine tests: answers like
// `claude -p --output-format json` does, and records what it was given.
//
// FAKE_CLAUDE_MODE: ok (default) | echo | not-logged-in | limit | crash | slow | noise | oracle
// FAKE_CLAUDE_REPLY: the reply text for "ok" (default "OK")
// FAKE_CLAUDE_SLEEP_MS: delay for "slow" (default 10000)
// FAKE_CLAUDE_LOGGED_IN: "0" makes `auth status` report signed out
// FAKE_CLAUDE_LOG: append one JSON line per call (argv, env, stdin, cwd)
// FAKE_CLAUDE_ORACLE: a module path exporting answer(prompt) -> text (mode "oracle")
const fs = require('fs')

const argv = process.argv.slice(2)
const mode = process.env.FAKE_CLAUDE_MODE || 'ok'

if (argv[0] === 'auth' && argv[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: process.env.FAKE_CLAUDE_LOGGED_IN !== '0', authMethod: 'claude.ai' }))
  process.exit(0)
}

const result = (text, extra = {}) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1,
  usage: { input_tokens: 2, cache_creation_input_tokens: Math.ceil(text.length / 4), cache_read_input_tokens: 0, output_tokens: 10 },
  ...extra,
})

let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', d => { stdin += d })
process.stdin.on('end', () => {
  if (process.env.FAKE_CLAUDE_LOG) {
    const keep = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
      /^(CLAUDE|ANTHROPIC|ENABLE_CLAUDEAI|DISABLE_AUTOUPDATER|ELECTRON_RUN_AS_NODE)/.test(k)))
    fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
      argv, env: keep, stdin, cwd: process.cwd(), cwdEntries: fs.readdirSync(process.cwd()),
    }) + '\n')
  }
  switch (mode) {
    case 'echo':
      console.log(result(stdin))
      process.exit(0)
    case 'not-logged-in':
      console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }))
      process.exit(1)
    case 'limit':
      console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Usage limit reached · resets 3pm' }))
      process.exit(1)
    case 'crash':
      process.exit(3)
    case 'slow':
      setTimeout(() => { console.log(result('late')); process.exit(0) }, Number(process.env.FAKE_CLAUDE_SLEEP_MS || 10000))
      return
    case 'noise':
      console.log('some banner line')
      console.log(result(process.env.FAKE_CLAUDE_REPLY || 'OK'))
      process.exit(0)
    case 'oracle': {
      const oracle = require(process.env.FAKE_CLAUDE_ORACLE)
      console.log(result(oracle.answer(stdin)))
      process.exit(0)
    }
    default:
      console.log(result(process.env.FAKE_CLAUDE_REPLY || 'OK'))
      process.exit(0)
  }
})
