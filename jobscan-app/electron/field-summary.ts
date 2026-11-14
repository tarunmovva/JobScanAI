import type { FormField } from '../src/types'

/**
 * Compact the extracted form fields down to what the payload agent needs.
 *
 * `options_truncated` MUST survive this compaction. The extractor caps option
 * collection at 80, so a Greenhouse School typeahead arrives as an alphabetical
 * A-only sample ('Aalborg University' ... 'Arkansas Baptist College'). Dropping
 * the flag left the agent seeing a plain 80-option dropdown plus PAYLOAD_SYSTEM
 * rule 3's "pick the CLOSEST listed option" — which answered 'American
 * University' in nearly two thirds of recorded runs for a resume whose school was not in the sample.
 *
 * The flag is emitted BEFORE `options` so the caveat is read ahead of the list
 * it qualifies. Deliberately NOT forwarded: `options_note` ("Select from the
 * available options.") and `supports_custom_input: false`, both of which
 * contradict the typeahead exception the flag is meant to trigger.
 */
export function summarizeFieldsForPrompt(fields: FormField[]): Array<Record<string, unknown>> {
  return (fields ?? []).map(f => ({
    id: f.id, label: f.label, type: f.type, required: f.required,
    ...(f.options_truncated ? { options_truncated: true } : {}),
    ...(f.options && f.options.length > 0
      ? { options: f.options.map((o: unknown) => typeof o === 'string' ? o : ((o as Record<string,string>)['text'] || (o as Record<string,string>)['label'] || '')).filter(Boolean) }
      : {}),
  }))
}
