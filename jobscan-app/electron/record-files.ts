/**
 * Which files an application record is allowed to open.
 *
 * History records link to the documents that were actually sent — the resume
 * and the generated cover letter. The path travels to the renderer and back, so
 * it is untrusted on return and must be re-checked here before anything opens.
 *
 * Two allowances, both narrow: anything inside the job-automator home (where
 * generated cover letters live, under applications/<platform>/<job_id>/), and
 * the configured resume, which the user picked deliberately and which normally
 * sits outside that tree.
 */
import path from 'path'

function within(root: string, target: string): boolean {
  if (!root) return false
  return target === root || target.startsWith(root + path.sep)
}

export function isOpenableRecordFile(
  home: string, resumePath: string, target: string,
): boolean {
  const t = String(target ?? '').trim()
  if (!t) return false
  const resolved = path.resolve(t)
  const homeRoot = home ? path.resolve(home) : ''
  const resume = resumePath ? path.resolve(resumePath) : ''
  // Exact match for the resume: allowing its DIRECTORY would open the user's
  // whole Downloads folder to anything the renderer asks for.
  return within(homeRoot, resolved) || (!!resume && resolved === resume)
}

export const __testing = { within }
