/**
 * The public engine's API. The GitHub Action front door in this repo uses it,
 * and the private enterprise host imports it as a package to build its App/
 * webhook front door and its Postgres-backed corpus on top of the same seams.
 *
 * Everything a host needs to review a pull request is here: the `runReview`
 * seam, the provider-neutral review model, the GitHub client, and the store
 * interfaces (with the open-source, database-free dedupe store).
 */

// The review seam and the pieces that make up a review.
export { runReview, buildTrainingRecord } from "./review/runReview.js";
export type { RunReviewDeps } from "./review/runReview.js";
export {
  reviewPullRequest,
  SEVERITY_THRESHOLD,
  MAX_CONTEXT_BYTES,
} from "./review/reviewPullRequest.js";
export type {
  ReviewDeps,
  ReviewResult,
  GatedFinding,
} from "./review/reviewPullRequest.js";
export {
  postReview,
  parsePostableLines,
  extractDiffHunk,
} from "./review/postReview.js";
export type {
  PostReviewDeps,
  PostReviewOutcome,
  PostedFinding,
} from "./review/postReview.js";
export {
  fingerprintMarker,
  extractFingerprints,
} from "./review/fingerprintMarker.js";
export {
  handlePullRequestOpened,
  PLACEHOLDER_COMMENT_BODY,
} from "./review/handlePullRequestOpened.js";
export type { Logger } from "./review/handlePullRequestOpened.js";

// The provider-neutral review model and its Anthropic implementation.
export {
  createAnthropicModel,
  parseFindings,
  DEFAULT_MODEL,
  DEFAULT_FALLBACK_MODEL,
  PROMPT_VERSION,
} from "./model/reviewModel.js";
export type {
  ReviewModel,
  ReviewModelOptions,
  ReviewRequest,
  ReviewResponse,
  ReviewFile,
  Finding,
  Severity,
} from "./model/reviewModel.js";

// The GitHub client and the bot-comment reader the dedupe store reads through.
export { createGitHubClient, createBotCommentReader } from "./github/client.js";
export type {
  GitHubClient,
  BotCommentReader,
  PostedCommentBody,
  PullRequestContext,
  ChangedFile,
  CreatedReview,
  InstallationOctokit,
} from "./github/client.js";

// The store seams: the narrow dedupe interface, the corpus, and the fingerprint.
export { fingerprintFinding } from "./store/trainingStore.js";
export type {
  PostedFindingsStore,
  TrainingStore,
  TrainingReviewRecord,
  TrainingFindingRecord,
  FindingPlacement,
  OutcomeEvent,
  OutcomeEventType,
  PostedFingerprintQuery,
  CommentLookupQuery,
  PostedFindingLocation,
} from "./store/trainingStore.js";
export { createGitHubPostedFindingsStore } from "./store/postedFindingsStore.js";

// The blast-radius check: which pull requests are small enough to auto-merge.
export {
  classifyChange,
  DEFAULT_CONFIG as DEFAULT_BLAST_RADIUS_CONFIG,
} from "./blastRadius/rules.js";
export type {
  Verdict,
  Tier,
  ChangedPath,
  BlastRadiusConfig,
  BlastRadiusLimits,
  BlastRadiusResult,
  ClassifiedFile,
} from "./blastRadius/rules.js";
export { loadBlastRadiusConfig, BlastRadiusConfigError } from "./blastRadius/config.js";
export { countImporters, findImportSpecifiers } from "./blastRadius/importGraph.js";
export { runBlastRadius } from "./blastRadius/runBlastRadius.js";
export type {
  BlastRadiusTarget,
  BlastRadiusGitHub,
  RunBlastRadiusDeps,
} from "./blastRadius/runBlastRadius.js";
export { createBlastRadiusGitHub } from "./blastRadius/github.js";
export { CHECK_NAME as BLAST_RADIUS_CHECK_NAME } from "./blastRadius/report.js";
