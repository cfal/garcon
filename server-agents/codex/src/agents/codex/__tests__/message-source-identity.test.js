import { describe, expect, it } from 'bun:test';
import { AssistantMessage, BashToolUseMessage, ToolResultMessage } from '@garcon/common/chat-types';
import { codexMessageSourceIdentity } from '../message-source-identity.js';

// Locks the canonical Codex identity tuples both the live turn-item ledger
// and JSONL evidence normalization attach: the same turn, item, and tool
// identities must produce the same entryId and subrow ordinal on both paths
// or the projection audit cannot match live rows against rollout evidence.
describe('codexMessageSourceIdentity', () => {
  const timestamp = '2026-07-04T00:00:00.000Z';

  it('keys item rows by turn and item with the rendered ordinal', () => {
    const message = new AssistantMessage(timestamp, 'answer');
    expect(codexMessageSourceIdentity({
      turnId: 'turn-1',
      itemId: 'item-9',
      message,
      fallbackOrdinal: 2,
    })).toEqual({ entryId: 'turn:turn-1:item:item-9', withinSourceOrdinal: 2 });
  });

  it('keys tool rows by tool call with use and result subrows', () => {
    const use = new BashToolUseMessage(timestamp, 'call-3', 'true', null);
    const result = new ToolResultMessage(timestamp, 'call-3', 'ok', false);
    expect(codexMessageSourceIdentity({
      turnId: 'turn-1',
      itemId: 'item-9',
      message: use,
      fallbackOrdinal: 0,
    })).toEqual({ entryId: 'turn:turn-1:tool:call-3', withinSourceOrdinal: 0 });
    expect(codexMessageSourceIdentity({
      turnId: 'turn-1',
      itemId: null,
      message: result,
      fallbackOrdinal: 5,
    })).toEqual({ entryId: 'turn:turn-1:tool:call-3', withinSourceOrdinal: 1 });
  });

  it('yields no identity without a turn or without any item or tool key', () => {
    const message = new AssistantMessage(timestamp, 'answer');
    expect(codexMessageSourceIdentity({
      turnId: null,
      itemId: 'item-9',
      message,
      fallbackOrdinal: 0,
    })).toBeNull();
    expect(codexMessageSourceIdentity({
      turnId: 'turn-1',
      itemId: null,
      message,
      fallbackOrdinal: 0,
    })).toBeNull();
  });
});
