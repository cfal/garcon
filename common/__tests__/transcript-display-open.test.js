import { describe, expect, it } from 'bun:test';
import { ExitPlanModeToolUseMessage, UserMessage } from '../chat-types.js';
import { parseDisplayOpenResponse, parsePlanPresentationDetail } from '../transcript-display-open.js';

const identity = { serverInstanceId: 'instance', chatId: '1234567890123456', transcriptViewId: 'view' };
function open() {
  return { serverInstanceId: identity.serverInstanceId, transcriptViewId: identity.transcriptViewId, sourceHead: 10,
    chat: { id: identity.chatId, title: 'Synthetic chat', agentId: 'claude', agentOwnershipEpoch: 'epoch', carryOverRevision: 'carry', model: null,
      apiProviderId: null, modelEndpointId: null, modelProtocol: null, permissionMode: 'default', thinkingMode: 'none', projectPath: '/workspace', tags: [],
      canReloadFromNativeHistory: false, activity: { createdAt: null, lastActivityAt: null } },
    display: { policyRevision: 1, bashRevision: 'revision', preparedThrough: 10, phase: 'available', errorCode: null },
    processingPhase: null,
    control: { serverInstanceId: identity.serverInstanceId, version: 0, updatedAt: null,
      queue: { entries: [], steeringEntryId: null, recentlyDispatched: [], pause: null, reorderRevision: 0 } },
    transientFeed: { ...identity, transientRevision: 0, rows: [] },
    plan: { ...identity, revision: 1, latestEnterOrdinal: 2, pendingExitCount: 1, exits: [{ ordinal: 3, timestamp: '2026-01-01T00:00:00.000Z' }], nextAfterOrdinal: null },
    submissions: [{ clientMessageId: 'input-1', ordinal: 1 }] };
}

describe('display open and plan details', () => {
  it('round-trips one consistent source and process identity', () => {
    const value = open();
    expect(parseDisplayOpenResponse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    const detail = { ...identity, ordinal: 3, message: new ExitPlanModeToolUseMessage('2026-01-01T00:00:00.000Z', 'tool-1', 'Synthetic plan') };
    expect(parsePlanPresentationDetail(JSON.parse(JSON.stringify(detail)))).toEqual(detail);
  });

  it('rejects mixed process snapshots and future evidence', () => {
    for (const part of ['transientFeed', 'control', 'plan']) {
      const value = open(); value[part].serverInstanceId = 'old-instance';
      expect(() => parseDisplayOpenResponse(value)).toThrow();
    }
    for (const mutate of [value => { value.display.preparedThrough = 11; }, value => { value.plan.latestEnterOrdinal = 11; },
      value => { value.plan.exits[0].ordinal = 11; }, value => { value.submissions.push(value.submissions[0]); }]) {
      const value = open(); mutate(value);
      expect(() => parseDisplayOpenResponse(value)).toThrow();
    }
  });

  it('rejects wrong plan message kinds and missing detail identity', () => {
    const detail = { ...identity, ordinal: 3, message: new UserMessage('2026-01-01T00:00:00.000Z', 'Not a plan') };
    expect(() => parsePlanPresentationDetail(detail)).toThrow();
    expect(() => parsePlanPresentationDetail({ ordinal: 3, message: new ExitPlanModeToolUseMessage('2026-01-01T00:00:00.000Z', 'tool-1', 'Plan') })).toThrow();
  });
});
