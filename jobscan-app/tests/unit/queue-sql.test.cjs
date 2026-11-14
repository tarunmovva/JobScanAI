// SQL the app runs against jobs.db's applications table.
//
// The reset before extraction used to be one synchronous `python -c` spawn
// per selected job, on the main process -- the window stalled for the whole
// loop. It is now one statement for the whole selection, run asynchronously.
// The other two let loop mode skip the queued jobs of a platform it paused.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const { resetSelectedSql, skipPlatformSql, markSkippedSql, abandonOthersSql } = require('../../out/unit/electron/queue-sql.js')

test('one reset statement covers the whole selection, quotes escaped', () => {
  assert.equal(resetSelectedSql(['1234567', "o'brien-1"]),
    "UPDATE applications SET status='queued',fill_result=NULL,fill_payload_path=NULL,extracted_fields_path=NULL,claim_token=NULL,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE job_id IN ('1234567','o''brien-1')")
  assert.equal(resetSelectedSql([]), '')
  assert.equal(resetSelectedSql(['', '  ']), '')
})

test('a platform sweep touches only rows nobody is working on', () => {
  const sql = skipPlatformSql('lever', 'skipped: lever paused after CAPTCHAs')
  assert.equal(sql,
    "UPDATE applications SET status='skipped', error='skipped: lever paused after CAPTCHAs', updated_at=CURRENT_TIMESTAMP WHERE platform='lever' AND status IN ('queued','extracted')")
})

// The extractor reads every queued row of a platform, and agents claim
// every extracted row. A row an earlier run left queued would be read and
// filled in this one without being picked.
test('before a run, every row of another run is abandoned, queued ones too', () => {
  assert.equal(abandonOthersSql(['1234567', "o'brien-1"]),
    "UPDATE applications SET status='failed', error='abandoned — not in current run', updated_at=CURRENT_TIMESTAMP "
    + "WHERE status IN ('queued','extracted','claimed','filling') AND job_id NOT IN ('1234567','o''brien-1')")
  assert.equal(abandonOthersSql([]),
    "UPDATE applications SET status='failed', error='abandoned — not in current run', updated_at=CURRENT_TIMESTAMP "
    + "WHERE status IN ('queued','extracted','claimed','filling')")
})

test('a single job is marked skipped with its reason', () => {
  assert.equal(markSkippedSql('lever', "ab'c", "lever paused until 03:40"),
    "UPDATE applications SET status='skipped', error='lever paused until 03:40', updated_at=CURRENT_TIMESTAMP WHERE platform='lever' AND job_id='ab''c'")
})
