// A test's standing on Ruffle's corpus, as run.ts records it in
// baseline.json and the site's compatibility page reads it.

/** How the player stood on one test: a pass is every line matched, no more traced, and no error. */
export interface Standing {
  /** Lines matched before the first difference, of `lines` Flash traced. */
  matched: number;
  lines: number;
  /** Lines the player traced, more than `lines` when it went on past Flash's. */
  traced: number;
  /** What stopped the player: an exception's text, "timeout", or null. */
  error: string | null;
}

/** A pass: every line matched, no more traced, and no error. */
export function passed(s: Standing): boolean {
  return s.matched === s.lines && s.traced === s.lines && !s.error;
}
