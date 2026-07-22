/**
 * An invisible marker embedded in every posted finding, so a later run can tell
 * which findings it has already posted on a pull request — without any database.
 *
 * It is written as an HTML comment: GitHub never shows it to a reader, but the
 * raw comment body still carries it, so a re-review can read the bot's own prior
 * comments back and rebuild the set of fingerprints it has already shown. This is
 * what lets cross-push dedupe work from a stateless GitHub Action, where there is
 * no store to remember between runs.
 */
const MARKER_RE = /<!--\s*postdev:fp:([0-9a-f]{64})\s*-->/g;

/** The marker to append to a posted finding's body for the given fingerprint. */
export function fingerprintMarker(fingerprint: string): string {
  return `<!-- postdev:fp:${fingerprint} -->`;
}

/**
 * Every fingerprint marked in a comment body. A body may carry more than one — a
 * summary review lists several findings — so this returns all of them, in order.
 * A body with no marker returns an empty array.
 */
export function extractFingerprints(body: string): string[] {
  const found: string[] = [];
  for (const match of body.matchAll(MARKER_RE)) {
    found.push(match[1]!);
  }
  return found;
}
