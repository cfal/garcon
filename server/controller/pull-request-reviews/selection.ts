import type { PullRequestSummary } from '../../../common/gh.js';
import {
  isActivePullRequestReviewRun,
  type PullRequestReviewSettings,
  type PullRequestReviewSkipReason,
} from '../../../common/pull-request-reviews.js';
import type { StoredRun } from './store.js';

const TRUSTED_ASSOCIATIONS = new Set(['owner', 'member', 'collaborator']);

export type AutoReviewDecision =
  | { kind: 'review' }
  // Waiting for pushes to settle; reviewed on a later scan.
  | { kind: 'wait' }
  // A review is in progress, or this head has already been reviewed.
  | { kind: 'settled' }
  | { kind: 'skip'; reason: PullRequestReviewSkipReason };

export interface AutoReviewInput {
  settings: PullRequestReviewSettings;
  pull: PullRequestSummary;
  // Runs of this pull request, in any order.
  runs: readonly StoredRun[];
  // When the scanner first saw the current head commit.
  headObservedAt: number;
  // Automatic reviews this repository started in the last day.
  startedInLastDay: number;
  now: number;
}

function filterReason(settings: PullRequestReviewSettings, pull: PullRequestSummary): PullRequestReviewSkipReason | null {
  const { filters } = settings;
  if (filters.skipDrafts && pull.isDraft) return 'draft';
  if (filters.trustedAuthorsOnly && !pull.authoredByViewer && !TRUSTED_ASSOCIATIONS.has(pull.authorAssociation)) return 'untrusted-author';
  if (pull.isCrossRepository) return 'fork';
  if (filters.baseBranches.length > 0 && !filters.baseBranches.includes(pull.baseRefName)) return 'base-branch';
  if (pull.labels.some((label) => filters.excludeLabels.includes(label))) return 'label';
  if (filters.includeLabels.length > 0 && !pull.labels.some((label) => filters.includeLabels.includes(label))) return 'label';
  if (filters.maxChangedLines !== null && pull.additions + pull.deletions > filters.maxChangedLines) return 'too-large';
  if (settings.onlyWhenReviewRequested && pull.reviewRequest === null) return 'review-not-requested';
  return null;
}

// Decides whether a scan should start an automatic review of a pull request's current head.
export function decideAutoReview(input: AutoReviewInput): AutoReviewDecision {
  const { settings, pull } = input;
  const head = pull.headRefOid;
  if (input.runs.some((run) => isActivePullRequestReviewRun(run.state))) return { kind: 'settled' };
  const atHead = input.runs.filter((run) => run.headSha === head || run.reviewedSha === head);
  if (atHead.some((run) => run.state === 'completed' && run.reviewedSha === head)) return { kind: 'settled' };
  const filtered = filterReason(settings, pull);
  if (filtered) return { kind: 'skip', reason: filtered };
  if (atHead.some((run) => run.state === 'stopped')) return { kind: 'skip', reason: 'stopped' };
  const attempts = atHead.filter((run) => run.trigger === 'auto').length;
  if (attempts >= settings.maxAttemptsPerCommit) return { kind: 'skip', reason: 'attempts-exhausted' };
  if (input.now - input.headObservedAt < settings.debounceMinutes * 60_000) return { kind: 'wait' };
  if (input.startedInLastDay >= settings.dailyReviewLimit) return { kind: 'skip', reason: 'daily-limit' };
  return { kind: 'review' };
}
