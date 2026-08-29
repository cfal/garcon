import { describe, expect, it } from 'bun:test';
import {
  CliRowMessage,
  ErrorMessage,
  parseChatMessage,
  TranscriptNoticeMessage,
} from '../chat-types.ts';
import {
  isChatIdDiscoveryFailureNoticeDetail,
  isHandoffSummaryNoticeDetail,
  isInterAgentMessageOutcomeNoticeDetail,
  isInterAgentMessageReceivedNoticeDetail,
  isSubAgentStartOutcomeNoticeDetail,
  parseTranscriptNoticeDetail,
  renderSubAgentStartOutcome,
} from '../transcript-notice-details.ts';

const AT = '2026-08-16T00:00:00.000Z';

describe('transcript notice contracts', () => {
  it('[TLV5-ADOPT.04-CONTRACT-01] round-trips the typed carryover quarantine detail exactly', () => {
    const message = {
      type: 'transcript-notice',
      timestamp: AT,
      content: 'Some earlier chat history could not be migrated. Quarantine reference: artifact-1.',
      detail: {
        type: 'carryover-migration-quarantine',
        artifactId: 'artifact-1',
        errorCode: 'CARRYOVER_PARSE_FAILED',
      },
    };

    const parsed = parseChatMessage(message);

    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe('transcript-notice');
    expect(parsed?.detail).toEqual(message.detail);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(message);
  });

  it('round-trips typed handoff summaries without matching title-only notices', () => {
    const message = {
      type: 'transcript-notice',
      timestamp: AT,
      content: 'Objective and current state.',
      detail: { type: 'handoff-summary' },
      title: 'Handoff summary',
    };

    expect(JSON.parse(JSON.stringify(parseChatMessage(message)))).toEqual(message);
    expect(isHandoffSummaryNoticeDetail(message.detail)).toBe(true);
    expect(isHandoffSummaryNoticeDetail({
      type: 'handoff-summary',
      title: 'Handoff summary',
    })).toBe(true);
    expect(isHandoffSummaryNoticeDetail({ title: 'Handoff summary' })).toBe(false);
    expect(isHandoffSummaryNoticeDetail({ type: 'ordinary-notice' })).toBe(false);
  });

  it('round-trips typed chat ID discovery notices', () => {
    for (const detail of [
      { type: 'chat-id-disclosure' },
      { type: 'chat-id-discovery-failure', reason: 'disabled' },
      { type: 'chat-id-discovery-failure', reason: 'delivery-failed' },
    ]) {
      const message = {
        type: 'transcript-notice',
        timestamp: AT,
        content: 'Synthetic discovery notice.',
        detail,
        title: 'Garcon Chat ID',
      };
      expect(JSON.parse(JSON.stringify(parseChatMessage(message)))).toEqual(message);
    }
    expect(isChatIdDiscoveryFailureNoticeDetail({
      type: 'chat-id-discovery-failure',
      reason: 'unsupported',
    })).toBe(false);
    expect(isChatIdDiscoveryFailureNoticeDetail({
      type: 'chat-id-discovery-failure',
      reason: 'invalid',
    })).toBe(false);
  });

  it('round-trips typed inter-agent message notices', () => {
    const outcome = {
      type: 'inter-agent-message-outcome',
      results: [
        { chatId: '1787974832309199', status: 'delivered' },
        { chatId: '1787973671383699', status: 'queued' },
        { chatId: '1787971111111111', status: 'failed', reason: 'target-not-found' },
      ],
    };
    const received = {
      type: 'inter-agent-message-received',
      fromChatId: '1787974832309199',
    };
    const hidden = {
      type: 'inter-agent-message-received',
      fromChatId: null,
    };

    for (const detail of [outcome, received, hidden]) {
      const message = {
        type: 'transcript-notice',
        timestamp: AT,
        content: 'Inter-agent message.',
        detail,
        title: 'Inter-agent message',
      };
      expect(JSON.parse(JSON.stringify(parseChatMessage(message)))).toEqual(message);
      expect(parseTranscriptNoticeDetail({ ...detail, ignored: true })).toEqual(detail);
    }
    expect(isInterAgentMessageOutcomeNoticeDetail(outcome)).toBe(true);
    expect(isInterAgentMessageReceivedNoticeDetail(received)).toBe(true);
    expect(isInterAgentMessageReceivedNoticeDetail(hidden)).toBe(true);
  });

  it('rejects malformed inter-agent message notice details', () => {
    for (const detail of [
      { type: 'inter-agent-message-outcome', results: [] },
      {
        type: 'inter-agent-message-outcome',
        results: [{ chatId: 'invalid', status: 'delivered' }],
      },
      {
        type: 'inter-agent-message-outcome',
        results: [
          { chatId: '1787974832309199', status: 'queued' },
          { chatId: '1787974832309199', status: 'delivered' },
        ],
      },
      {
        type: 'inter-agent-message-outcome',
        results: [{ chatId: '1787974832309199', status: 'failed', reason: 'invalid' }],
      },
      { type: 'inter-agent-message-received', fromChatId: 'invalid' },
      { type: 'inter-agent-message-received' },
    ]) {
      expect(parseTranscriptNoticeDetail(detail)).toBeNull();
    }
  });

  it('round-trips typed sub-agent start outcomes', () => {
    const detail = {
      type: 'sub-agent-start-outcome',
      deliveryStatus: 'queued',
      results: [
        {
          ref: '69b623a7-757e-49f6-93b8-4b7ea1bc569b',
          error: false,
          msg: 'created',
          chatId: '1787974832309199',
        },
        {
          ref: '2cf0e440-11b4-41aa-bc90-36145b214f66',
          error: true,
          msg: 'unknown-model',
        },
      ],
    };
    const message = {
      type: 'transcript-notice',
      timestamp: AT,
      content: renderSubAgentStartOutcome(detail.deliveryStatus, detail.results),
      detail,
      title: 'Sub-agent start',
    };

    expect(JSON.parse(JSON.stringify(parseChatMessage(message)))).toEqual(message);
    expect(isSubAgentStartOutcomeNoticeDetail(detail)).toBe(true);
    expect(parseTranscriptNoticeDetail({ ...detail, ignored: true })).toEqual(detail);
  });

  it('rejects malformed sub-agent start outcomes', () => {
    const ref = '69b623a7-757e-49f6-93b8-4b7ea1bc569b';
    const result = { ref, error: true, msg: 'start-failed' };
    for (const detail of [
      { type: 'sub-agent-start-outcome', deliveryStatus: 'invalid', results: [result] },
      { type: 'sub-agent-start-outcome', deliveryStatus: 'delivered', results: [] },
      {
        type: 'sub-agent-start-outcome',
        deliveryStatus: 'delivered',
        results: [result, result],
      },
      {
        type: 'sub-agent-start-outcome',
        deliveryStatus: 'delivered',
        results: [{ ref, error: false, msg: 'created' }],
      },
      {
        type: 'sub-agent-start-outcome',
        deliveryStatus: 'delivered',
        results: [{ ref, error: true, msg: 'created' }],
      },
    ]) {
      expect(parseTranscriptNoticeDetail(detail)).toBeNull();
    }
  });

  it('round-trips title-only notices without inventing semantic detail', () => {
    const message = {
      type: 'transcript-notice',
      timestamp: AT,
      content: 'Earlier chat history was small enough to carry over as context.',
      title: 'History carried without compaction',
    };

    expect(JSON.parse(JSON.stringify(parseChatMessage(message)))).toEqual(message);
  });

  it('centralizes semantic detail parsing and rejects unknown details', () => {
    expect(parseTranscriptNoticeDetail({
      type: 'carryover-migration-quarantine',
      artifactId: 'artifact-1',
      errorCode: 'CARRYOVER_PARSE_FAILED',
      ignored: 'not projected',
    })).toEqual({
      type: 'carryover-migration-quarantine',
      artifactId: 'artifact-1',
      errorCode: 'CARRYOVER_PARSE_FAILED',
    });
    expect(parseTranscriptNoticeDetail({
      type: 'chat-id-disclosure',
      delivery: 'queued',
    })).toEqual({ type: 'chat-id-disclosure' });
    expect(parseTranscriptNoticeDetail({
      type: 'chat-id-discovery-failure',
      reason: 'invalid',
    })).toBeNull();
    expect(parseTranscriptNoticeDetail({ type: 'ordinary-notice' })).toBeNull();
  });

  it('does not reinterpret other message kinds as CLI rows', () => {
    const formerCliNotice = parseChatMessage({
      type: 'transcript-notice',
      timestamp: AT,
      content: 'Former CLI notice shape.',
      detail: { type: 'cli-row' },
    });
    expect(formerCliNotice).toEqual(new TranscriptNoticeMessage(
      AT,
      'Former CLI notice shape.',
    ));
    expect(formerCliNotice).not.toBeInstanceOf(CliRowMessage);

    const error = parseChatMessage({
      type: 'error',
      timestamp: AT,
      content: 'Former CLI error shape.',
      title: 'Ignored title',
      detail: { type: 'cli-row' },
    });
    expect(error).toBeInstanceOf(ErrorMessage);
    expect(error).not.toBeInstanceOf(CliRowMessage);
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      type: 'error',
      timestamp: AT,
      content: 'Former CLI error shape.',
    });
  });

  it('renders unknown semantic detail as a plain transcript notice', () => {
    expect(parseChatMessage({
      type: 'transcript-notice',
      timestamp: AT,
      content: 'Future notice shape.',
      detail: { type: 'not-yet-known' },
      title: 'Future notice',
    })).toEqual(new TranscriptNoticeMessage(
      AT,
      'Future notice shape.',
      undefined,
      'Future notice',
    ));
  });

  it('round-trips explicit preset and custom CLI rows', () => {
    for (const presentation of [
      { style: 'info' },
      { style: 'notice' },
      { style: 'error' },
      {
        style: 'custom',
        customStyle: { lightAccent: '#7c3aed', darkAccent: '#c4b5fd' },
      },
    ]) {
      const message = {
        type: 'cli-row',
        timestamp: AT,
        content: '**Deployment complete.**',
        presentation,
        format: 'markdown',
        title: 'Deployment',
        disclosure: 'collapsed',
      };
      expect(JSON.parse(JSON.stringify(parseChatMessage(message)))).toEqual(message);
    }
  });

  it('safely normalizes malformed explicit CLI presentation', () => {
    expect(parseChatMessage({
      type: 'cli-row',
      timestamp: AT,
      content: 'Malformed custom.',
      presentation: { style: 'custom', customStyle: { lightAccent: 'red' } },
      format: 'html',
    })).toEqual(new CliRowMessage(AT, 'Malformed custom.', { style: 'notice' }, 'plain'));

    expect(parseChatMessage({ type: 'error', timestamp: AT, content: 'Provider failed.' }))
      .toEqual(new ErrorMessage(AT, 'Provider failed.'));
  });
});
