// Stands in for Codex where Codex must never run: records that it was
// started (CODEX_TRIPWIRE names the marker file) and fails.
require('fs').writeFileSync(process.env.CODEX_TRIPWIRE || 'codex-tripwire.marker', process.argv.slice(2).join(' '))
process.exit(1)
