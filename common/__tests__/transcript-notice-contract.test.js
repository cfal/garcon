import { describe, expect, it } from 'bun:test';
import {
  CliRowMessage,
  ErrorMessage,
  isHandoffSummaryNoticeDetail,
  parseChatMessage,
} from '../chat-types.ts';

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
    for (const message of [
      {
        type: 'transcript-notice',
        timestamp: AT,
        content: 'Agent requested chat ID',
        detail: { type: 'chat-id-request' },
        title: 'Request: Garcon Chat ID',
      },
      {
        type: 'transcript-notice',
        timestamp: AT,
        content: 'Sent chat ID 1787836573296800 to agent',
        detail: { type: 'chat-id-disclosure', delivery: 'input' },
        title: 'Response: Garcon Chat ID',
      },
      {
        type: 'transcript-notice',
        timestamp: AT,
        content: 'Sent chat ID 1787836573296800 to agent (steer)',
        detail: { type: 'chat-id-disclosure', delivery: 'steer' },
        title: 'Response: Garcon Chat ID',
      },
      {
        type: 'transcript-notice',
        timestamp: AT,
        content: 'Chat ID auto-discovery is disabled.',
        detail: { type: 'chat-id-discovery-disabled' },
        title: 'Request: Garcon Chat ID',
      },
    ]) {
      expect(JSON.parse(JSON.stringify(parseChatMessage(message)))).toEqual(message);
    }
    expect(parseChatMessage({
      type: 'transcript-notice',
      timestamp: AT,
      content: 'Malformed disclosure.',
      detail: { type: 'chat-id-disclosure', delivery: 'queued' },
    })).toBeNull();
  });

  it('upgrades legacy CLI provenance into explicit row messages', () => {
    for (const [type, style] of [
      ['transcript-notice', 'notice'],
      ['error', 'error'],
    ]) {
      const parsed = parseChatMessage({
        type,
        timestamp: AT,
        content: 'Synthetic CLI row.',
        title: 'Deployment',
        detail: {
          type: 'cli-row',
        },
      });

      expect(parsed).toBeInstanceOf(CliRowMessage);
      expect(JSON.parse(JSON.stringify(parsed))).toEqual({
        type: 'cli-row',
        timestamp: AT,
        content: 'Synthetic CLI row.',
        presentation: { style },
        format: 'plain',
        disclosure: 'expanded',
        title: 'Deployment',
      });
    }
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

  it('restores legacy defaults and safely normalizes malformed durable presentation', () => {
    expect(parseChatMessage({
      type: 'error',
      timestamp: AT,
      content: 'Untitled error.',
      detail: { type: 'cli-row' },
    })?.presentation).toEqual({ style: 'error' });

    const strayDetailTitle = parseChatMessage({
      type: 'transcript-notice',
      timestamp: AT,
      content: 'Stray detail title.',
      detail: { type: 'cli-row', title: 'Deployment' },
    });
    expect(strayDetailTitle?.presentation).toEqual({ style: 'notice' });
    expect(strayDetailTitle?.title).toBeUndefined();

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
