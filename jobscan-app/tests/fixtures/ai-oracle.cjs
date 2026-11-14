// One deterministic "AI" for the end-to-end tests, shared by the stand-in
// Codex (unit/fixtures/fake-app-server.cjs, FAKE_MODE=oracle) and the
// stand-in Claude Code (unit/fixtures/fake-claude.cjs, FAKE_CLAUDE_MODE=oracle).
// The same prompt gets the same reply from both, so the two engines must
// leave the app in the same state.
//
// The searches match the tiny database built by tests/fixtures/tiny-db.cjs.
const QUERIES = [
  { name: 'engineers_usa', flags: '--title-query "engineer" --market usa', description: 'Every engineer title in the US.' },
  { name: 'python_usa', flags: '--key-query "python" --market usa', description: 'Python in the description.' },
  { name: 'kafka_usa', flags: '--key-query "kafka" --market usa', description: 'Kafka in the description.' },
  { name: 'kubernetes_usa', flags: '--key-query "kubernetes" --market usa', description: 'Kubernetes in the description.' },
  { name: 'remote_engineers', flags: '--title-query "engineer" --remote', description: 'Remote engineer roles.' },
]

/** The score the oracle gives a job: stable, spread over 1-10. */
function scoreFor(jobId) {
  let h = 0
  for (const c of String(jobId)) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return 1 + (h % 10)
}

function answer(prompt) {
  const text = String(prompt)
  if (text.includes('You generate jobscan CLI search queries')) {
    if (/Respond QUERIES_DONE to stop/.test(text)) return 'QUERIES_DONE'
    const m = /Generate query #(\d+)/.exec(text)
    const n = m ? Number(m[1]) : 1
    return JSON.stringify(QUERIES[(n - 1) % QUERIES.length])
  }
  if (text.includes('senior technical recruiter')) {
    const jobs = JSON.parse(text.slice(text.lastIndexOf('JOBS:\n') + 'JOBS:\n'.length))
    return JSON.stringify(jobs.map(j => ({ job_id: j.job_id, platform: j.platform, rating: scoreFor(j.job_id), reason: 'fixture' })))
  }
  return JSON.stringify({ answers: {} })
}

module.exports = { answer, scoreFor, QUERIES }
