import { parseRevisionInvalidation } from '../../../../../common/ws-revision-invalidations.ts';

export function revision(value: unknown): boolean {
  return parseRevisionInvalidation({ type: 'tickets-invalidated', revision: value }) !== null;
}
