/**
 * JOBSCAN_USER_DATA_DIR: keep this run's settings and data in another
 * directory instead of the usual one (%APPDATA%\jobscan-app, or
 * ~/Library/Application Support/jobscan-app) -- for trying a fresh setup,
 * or a second checkout, without touching your real profile and history.
 *
 * Must run before the store is created: main.ts imports it first.
 */
import { app } from 'electron'
import path from 'path'

const dir = (process.env['JOBSCAN_USER_DATA_DIR'] ?? '').trim()
if (dir) {
  app.setPath('userData', path.resolve(dir))
  console.log(`[user-data] using ${path.resolve(dir)}`)
}
