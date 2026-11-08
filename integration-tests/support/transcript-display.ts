import type { DisplayOpenResponse } from '../../common/transcript-display-open.js';
import { parseBodyDependencyResponse, parseDisplayWindowResponse, type AvailableDisplayWindow, type DisplayWindowRequest } from '../../common/transcript-display-contract.js';
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

export async function measuredDisplaySnapshot(client: GarconTestClient, request: DisplayWindowRequest, window: AvailableDisplayWindow) {
  let bytes = 0;
  const read = async (operation: string, body: unknown): Promise<unknown> => {
    const response = await client.fetch(`/api/v1/chats/transcript-display/${operation}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const payload = await response.arrayBuffer();
    bytes += payload.byteLength;
    if (!response.ok) throw new Error(`Display ${operation}: HTTP ${response.status}`);
    return JSON.parse(new TextDecoder().decode(payload));
  };
  const measuredWindow = parseDisplayWindowResponse(await read('window', { ...request, atWatermark: window.certificate.watermark }));
  const bodies = parseBodyDependencyResponse(await read('bodies', { certificate: window.certificate, profile: request.profile, cuts: request.cuts,
    seedOrdinals: window.items.flatMap(item => item.kind === 'row' ? [item.ordinal] : []), residentOrdinals: [],
    limitBodies: 200, estimatedByteBudget: 2 * 1024 * 1024 }));
  return { window: measuredWindow, bodies, bytes };
}
