// After each loop job the app closes that job's tabs itself, because a filler
// that was killed or crashed can never close its own. It must close exactly
// that job's tabs: never a tab the user is using, never another job's tab --
// least of all one a normal run left open for the user to finish.
//
// A fake DevTools endpoint stands in for Chrome. chrome-tabs reads the port
// when it loads, so this file sets it first, in its own process.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')

const TABS = [
  { id: 'T1', type: 'page', title: 'Acme', url: 'https://www.acme.example.com/jobs/1234567?gh_jid=1234567' },
  { id: 'T2', type: 'page', title: '', url: 'https://job-boards.greenhouse.io/acme/jobs/1234567' },
  { id: 'T3', type: 'page', title: 'Inbox', url: 'https://mail.google.com/' },
  { id: 'T4', type: 'page', title: 'Acme', url: 'https://jobs.lever.co/acme/abc/apply' },
  { id: 'T5', type: 'iframe', title: '', url: 'https://job-boards.greenhouse.io/acme/jobs/1234567' },
  { id: 'T6', type: 'page', title: '', url: 'https://job-boards.greenhouse.io/embed/job_app?for=acme&token=1234567' },
  { id: 'T7', type: 'page', title: '', url: 'https://job-boards.greenhouse.io/embed/job_app?for=acme&token=4444444' },
]

async function fakeChrome() {
  const closed = []
  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') { res.end(JSON.stringify(TABS)); return }
    const m = /^\/json\/close\/(.+)$/.exec(req.url)
    if (m) { closed.push(decodeURIComponent(m[1])); res.end('Target is closing'); return }
    res.statusCode = 404; res.end()
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  process.env.JOB_AUTOMATOR_CDP_HOST = '127.0.0.1'
  process.env.JOB_AUTOMATOR_CDP_PORT = String(server.address().port)
  return { server, closed }
}

test('closeTabsFor closes only the tabs of that job', async () => {
  const { server, closed } = await fakeChrome()
  try {
    const { closeTabsFor } = require('../../out/unit/electron/chrome-tabs.js')
    const n = await closeTabsFor('https://www.acme.example.com/jobs/1234567?gh_jid=1234567')
    // The job's own page, its board page and its embed -- not the iframe
    // target, not the inbox, not the Lever job, not another company's embed.
    assert.deepEqual(closed.sort(), ['T1', 'T2', 'T6'])
    assert.equal(n, 3)
    closed.length = 0
    assert.equal(await closeTabsFor(''), 0)
    assert.deepEqual(closed, [])
  } finally {
    server.close()
  }
})
