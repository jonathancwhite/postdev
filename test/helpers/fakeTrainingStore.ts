import type {
  CommentLookupQuery,
  OutcomeEvent,
  PostedFindingLocation,
  TrainingReviewRecord,
  TrainingStore,
} from "../../src/store/trainingStore.js";

/**
 * An in-memory {@link TrainingStore} for tests. It keeps every record and every
 * outcome event it is asked to write, so a test can inject it and assert on the
 * exact rows the review flow and the outcome-mirroring handlers persist — no
 * database required.
 *
 * `postedFingerprints` answers from those records — the fingerprints of findings
 * that posted inline or into the summary on the matching pull request — plus any
 * `seedPosted` fingerprints the test supplies to stand in for an earlier review.
 * That lets a dedupe test seed "already posted" fingerprints without first
 * running a whole review.
 *
 * Each stored finding is given a synthetic, stable id (like findings.id in
 * Postgres) so `findFindingByCommentId` and `postedFindingLocations` can resolve
 * a webhook comment or a changed line back to a finding, exactly as the real
 * store does. A test can seed those directly with `seedFindings` when it does not
 * want to run a whole review first.
 */
export interface SeedFinding {
  findingId: number;
  owner: string;
  repo: string;
  pullNumber: number;
  file: string;
  line: number;
  githubCommentId: number | null;
}

export function createFakeTrainingStore(
  options: { seedPosted?: string[]; seedFindings?: SeedFinding[] } = {},
): {
  store: TrainingStore;
  records: TrainingReviewRecord[];
  events: OutcomeEvent[];
} {
  const records: TrainingReviewRecord[] = [];
  const events: OutcomeEvent[] = [];
  const seedPosted = new Set(options.seedPosted ?? []);

  // Every posted finding the store knows about, each with its own id — those
  // seeded up front and those learned as reviews are recorded.
  const findingRows: SeedFinding[] = [...(options.seedFindings ?? [])];
  let nextFindingId =
    findingRows.reduce((max, row) => Math.max(max, row.findingId), 0) + 1;

  const store: TrainingStore = {
    async recordReview(record) {
      records.push(record);
      for (const finding of record.findings) {
        if (finding.placement === "not-posted") continue;
        findingRows.push({
          findingId: nextFindingId++,
          owner: record.owner,
          repo: record.repo,
          pullNumber: record.pullNumber,
          file: finding.finding.file,
          line: finding.finding.line,
          githubCommentId: finding.githubCommentId,
        });
      }
    },
    async postedFingerprints({ owner, repo, pullNumber }) {
      const posted = new Set(seedPosted);
      for (const record of records) {
        if (
          record.owner !== owner ||
          record.repo !== repo ||
          record.pullNumber !== pullNumber
        ) {
          continue;
        }
        for (const finding of record.findings) {
          if (finding.placement === "inline" || finding.placement === "summary") {
            posted.add(finding.fingerprint);
          }
        }
      }
      return posted;
    },
    async recordEvent(event) {
      events.push(event);
    },
    async findFindingByCommentId({
      owner,
      repo,
      pullNumber,
      githubCommentId,
    }: CommentLookupQuery) {
      const match = findingRows.find(
        (row) =>
          row.owner === owner &&
          row.repo === repo &&
          row.pullNumber === pullNumber &&
          row.githubCommentId === githubCommentId,
      );
      return match ? match.findingId : null;
    },
    async postedFindingLocations({ owner, repo, pullNumber }) {
      return findingRows
        .filter(
          (row) =>
            row.owner === owner &&
            row.repo === repo &&
            row.pullNumber === pullNumber,
        )
        .map(
          (row): PostedFindingLocation => ({
            findingId: row.findingId,
            file: row.file,
            line: row.line,
            githubCommentId: row.githubCommentId,
          }),
        );
    },
  };
  return { store, records, events };
}
