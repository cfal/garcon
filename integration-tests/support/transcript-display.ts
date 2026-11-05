import type { DisplayOpenResponse } from '../../common/transcript-display-open.js';
import type { AvailableDisplayWindow, DisplayWindowRequest } from '../../common/transcript-display-contract.js';
import type { GarconTestClient } from './garcon-client.js';

export function displayRequest(
  open: DisplayOpenResponse,
  overrides: Partial<DisplayWindowRequest> = {},
): DisplayWindowRequest {
  return {
    chatId: open.chat.id, transcriptViewId: open.transcriptViewId,
    policyRevision: open.display.policyRevision,
    profile: { combine: true, showThinking: true, hiddenToolGroups: [], bashRevision: open.display.bashRevision },
    cuts: [], anchor: { kind: 'newest' }, requiredThrough: open.sourceHead, limit: 50,
    ...overrides,
  };
}

export function displayBodies(
  client: GarconTestClient, request: DisplayWindowRequest, window: AvailableDisplayWindow,
  seedOrdinals = window.items.flatMap(item => item.kind === 'row' ? [item.ordinal] : []),
  residentOrdinals: readonly number[] = [],
) {
  return client.displayBodies({
    certificate: window.certificate, profile: request.profile, cuts: request.cuts,
    seedOrdinals, residentOrdinals, limitBodies: 200, estimatedByteBudget: 2 * 1024 * 1024,
  });
}
