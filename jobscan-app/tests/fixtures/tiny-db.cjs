// A tiny job database for the end-to-end tests, built offline through the
// real jobscan CLI (`db exec`, then `db build-terms`), so search runs the real
// code against known rows. 40 companies x 3 jobs on Lever and Ashby, every
// one a US engineering role mentioning Python, Kafka and Kubernetes, half of
// them remote -- enough that each oracle search matches 40+ jobs.
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

function rows() {
  const out = []
  for (let c = 0; c < 40; c++) {
    const platform = c % 2 === 0 ? 'lever' : 'ashby'
    const slug = `fixture-co-${String(c).padStart(2, '0')}`
    for (let j = 0; j < 3; j++) {
      const n = c * 3 + j
      const jobId = `job-${String(n).padStart(3, '0')}`
      const remote = n % 2 === 0
      out.push({
        id: `${platform === 'lever' ? 'lv' : 'ab'}:${slug}:${jobId}`, platform, slug, company: `Fixture Company ${c}`, jobId,
        title: `${['Backend', 'Platform', 'Data'][j]} Engineer ${n}`,
        location: remote ? 'Remote - United States' : 'New York, NY',
        workplace: remote ? 'remote' : 'onsite',
        description: `Build services in Python and Go, run Kafka pipelines on Kubernetes clusters, role ${n} on the team`,
      })
    }
  }
  return out
}

const q = s => `'${String(s).replace(/'/g, "''")}'`

/** Builds <dir>/jobs.db next to a copy of the jobscan binary; returns the copy's path. */
function buildTinyDb(exeSource, dir) {
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(path.join(bin, 'data'), { recursive: true })
  const exe = path.join(bin, path.basename(exeSource))
  fs.copyFileSync(exeSource, exe)
  // No board lists: a stray Rebuild fails instead of replacing this database.
  const run = (...args) => execFileSync(exe, args, { cwd: bin, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const now = new Date().toISOString()
  const all = rows()
  for (let i = 0; i < all.length; i += 30) {
    const values = all.slice(i, i + 30).map(r => `(${[
      q(r.id), q(r.platform), q(r.slug), q(r.company), q(r.jobId), q(r.title), q(r.location), q('Engineering'),
      q(''), q('full-time'), q(r.workplace), q('US'), q(`https://jobs.example.com/${r.slug}/${r.jobId}`),
      q(`https://jobs.example.com/${r.slug}/${r.jobId}/apply`), q(now), q(now), q(r.description), q(''), q(now),
    ].join(',')})`).join(',')
    run('db', 'exec', `INSERT INTO jobs (id, platform, company_slug, company_name, job_id, title, location, department, team, employment_type, workplace_type, country, job_url, apply_url, posted_at, updated_at, description_plain, salary_raw, fetched_at) VALUES ${values}`)
  }
  // Markets are worked out when the table is empty and the database opens.
  run('db', 'exec', 'DELETE FROM job_markets')
  run('db', 'build-terms')
  return exe
}

module.exports = { buildTinyDb, rows }
