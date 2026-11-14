/**
 * The tags a card in Defects can carry, and what each one means.
 *
 * Shared by the board reducer (main process) and the board legend (renderer),
 * so it imports nothing.
 */

export const DEFECTS = ['needs_you', 'error', 'skipped'] as const

export type Defect = (typeof DEFECTS)[number]

export const DEFECT_TAGS: Array<{ id: Defect; label: string; meaning: string }> = [
  {
    id: 'needs_you',
    label: 'Needs you',
    meaning: 'The form is filled; one step only a person can do is left, in the open tab.',
  },
  {
    id: 'error',
    label: 'Error',
    meaning: 'The application failed — the card says why. Open the record for the details.',
  },
  {
    id: 'skipped',
    label: 'Skipped',
    meaning: 'The loop did not finish this job and closed its tab — the card says why. Usually it was not applied and you can still apply by hand; a fill cut off mid-way, or a submit that was never confirmed, may have gone in — check your email first.',
  },
]
