import type { PullRequestReviewRunState } from '../../../../../common/pull-request-reviews.ts';

const states: readonly PullRequestReviewRunState[] = [
  'queued', 'reviewing', 'needs-input', 'completed', 'outdated', 'failed', 'stopped', 'interrupted',
];
export function acceptsRunState(value: unknown): boolean {
  return states.some(state => state === value);
}
