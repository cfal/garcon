import type { PullRequestSummary } from '../../../common/gh.js';
import {
  type PullRequestReviewSettings,
  type PullRequestReviewSkipReason,
} from '../../../common/pull-request-reviews.js';
import type { ReviewSelectionHistory } from './store.js';

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
  history: ReviewSelectionHistory;
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

type ReviewEligibilityInput = Omit<AutoReviewInput, 'headObservedAt' | 'now'>;

function eligibilityDecision(input: ReviewEligibilityInput): AutoReviewDecision {
  const { settings, pull } = input;
  if (input.history.active || input.history.completed) return { kind: 'settled' };
  const filtered = filterReason(settings, pull);
  if (filtered) return { kind: 'skip', reason: filtered };
  if (input.history.stopped) return { kind: 'skip', reason: 'stopped' };
  if (input.history.attempts >= settings.maxAttemptsPerCommit) return { kind: 'skip', reason: 'attempts-exhausted' };
  return { kind: 'review' };
}

// Rechecks current policy before a previously eligible queued run claims a chat.
export function decideQueuedAutoReview(input: ReviewEligibilityInput): AutoReviewDecision {
  const eligible = eligibilityDecision(input);
  if (eligible.kind !== 'review') return eligible;
  return dailyLimitDecision(input);
}

function dailyLimitDecision(input: ReviewEligibilityInput): AutoReviewDecision {
  return input.startedInLastDay >= input.settings.dailyReviewLimit
    ? { kind: 'skip', reason: 'daily-limit' }
    : { kind: 'review' };
}

// Decides whether a scan should start an automatic review of a pull request's current head.
export function decideAutoReview(input: AutoReviewInput): AutoReviewDecision {
  const eligible = eligibilityDecision(input);
  if (eligible.kind !== 'review') return eligible;
  if (input.now - input.headObservedAt < input.settings.debounceMinutes * 60_000) return { kind: 'wait' };
  return dailyLimitDecision(input);
}
