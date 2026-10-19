// Collection invalidations that carry only the collection's new revision.

export class TicketsInvalidatedMessage {
  readonly type = 'tickets-invalidated' as const;
  constructor(public revision: number) {}
}

export class PullRequestReviewsInvalidatedMessage {
  readonly type = 'pull-request-reviews-invalidated' as const;
  constructor(public revision: number) {}
}

export type RevisionInvalidationMessage = TicketsInvalidatedMessage | PullRequestReviewsInvalidatedMessage;

const MESSAGES = {
  'tickets-invalidated': TicketsInvalidatedMessage,
  'pull-request-reviews-invalidated': PullRequestReviewsInvalidatedMessage,
} as const;

export function isRevisionInvalidationType(type: unknown): type is keyof typeof MESSAGES {
  return typeof type === 'string' && Object.hasOwn(MESSAGES, type);
}

// Accepts exactly `type` and a non-negative integer `revision`.
export function parseRevisionInvalidation(data: Record<string, unknown>): RevisionInvalidationMessage | null {
  if (!isRevisionInvalidationType(data.type) || Object.keys(data).length !== 2) return null;
  const { revision } = data;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return null;
  return new MESSAGES[data.type](revision);
}
