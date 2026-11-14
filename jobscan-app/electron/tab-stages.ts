// What the codes on the automated Chrome tabs mean.
//
// During a run up to nine tabs are open, each labelled "[FILL] acme - Senior
// Engineer" with a coloured favicon. A code nobody can decode is just noise,
// so the app shows this legend beside the board.
//
// This list MIRRORS job_application_automator/tab_tag.py STAGES. Python writes
// the labels; this only explains them. tests/unit/tab-stages.test.cjs reads
// both files and fails if they drift, because a legend that disagrees with the
// tabs is worse than none.
export type TabStage = 'extract' | 'fill' | 'fix' | 'needs' | 'failed' | 'done'

export interface TabStageSpec {
  /** Four characters, as shown in the tab title. */
  code: string
  /** The favicon colour for this stage. */
  color: string
  /** Plain-language explanation shown in the legend. */
  meaning: string
}

export const TAB_STAGES: Record<TabStage, TabStageSpec> = {
  extract: { code: 'EXTR', color: '#6b7280', meaning: 'Reading the form' },
  fill:    { code: 'FILL', color: '#ffb224', meaning: 'Answering and submitting' },
  fix:     { code: 'FIX!', color: '#f97316', meaning: 'Repair agent is fixing a problem' },
  needs:   { code: 'YOU!', color: '#ef4444', meaning: 'Needs you — finish in this tab' },
  failed:  { code: 'FAIL', color: '#a1382f', meaning: 'Attempt failed — left open for you' },
  done:    { code: 'DONE', color: '#22c55e', meaning: 'Submitted' },
}

// Left to right in the order work moves, so the legend reads like the board.
export const TAB_STAGE_ORDER: TabStage[] = ['extract', 'fill', 'fix', 'needs', 'failed', 'done']
