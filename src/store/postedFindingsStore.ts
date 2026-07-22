import type { BotCommentReader } from "../github/client.js";
import { extractFingerprints } from "../review/fingerprintMarker.js";
import type {
  PostedFindingsStore,
  PostedFingerprintQuery,
} from "./trainingStore.js";

/**
 * The open-source dedupe store: it answers "which fingerprints have already been
 * posted on this pull request?" with no database at all, by reading the bot's
 * own prior comments and reviews and pulling out the fingerprint markers they
 * carry. This is what lets a stateless GitHub Action skip a finding it already
 * posted on an earlier push — the enterprise host answers the same question from
 * Postgres instead.
 *
 * Its collaborator, the {@link BotCommentReader}, is injected, so a test drives
 * it with canned comments and asserts on the reconstructed set. `botLogin` is
 * whose comments count as the bot's — in an Action that is the identity the
 * workflow token posts under.
 */
export function createGitHubPostedFindingsStore(
  reader: BotCommentReader,
  botLogin: string,
): PostedFindingsStore {
  const isBot = (author: string | null): boolean =>
    author !== null && author.toLowerCase() === botLogin.toLowerCase();

  return {
    async postedFingerprints(
      query: PostedFingerprintQuery,
    ): Promise<Set<string>> {
      const [comments, reviews] = await Promise.all([
        reader.listReviewComments(query),
        reader.listReviews(query),
      ]);

      const fingerprints = new Set<string>();
      // Only the bot's own comments count — a human quoting a marker, or another
      // tool, must never make us think we already posted a finding we did not.
      for (const item of [...comments, ...reviews]) {
        if (!isBot(item.author)) continue;
        for (const fingerprint of extractFingerprints(item.body)) {
          fingerprints.add(fingerprint);
        }
      }
      return fingerprints;
    },
  };
}
