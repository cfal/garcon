import { describe, expect, it } from 'bun:test';
import {
  ChatHandoffArtifactContractError,
  parseChatHandoffArtifactResponse,
} from '../chat-handoff-artifact-contracts.ts';

const VALID = {
  success: true,
  chatId: '1787505989127000',
  transcriptViewId: 'view-synthetic-1',
  lastOrdinal: 42,
  generatedAt: '2026-08-26T00:00:00.000Z',
  contextWindowTokens: 131_072,
  usableTokenBudget: 98_304,
  estimatedTokens: 1_200,
  totalEntryCount: 12,
  includedEntryCount: 9,
  omittedEntryCount: 3,
  abridgedEntryCount: 2,
  gapCount: 2,
  truncated: true,
  documentCodeUnits: 7,
  document: '<xml/>\n',
};

describe('chat handoff artifact contract', () => {
  it('parses a relationally valid response', () => {
    expect(parseChatHandoffArtifactResponse(VALID)).toEqual(VALID);
  });

  it('accepts a complete empty artifact', () => {
    const document = '<handoff-artifact/>\n';
    expect(parseChatHandoffArtifactResponse({
      ...VALID,
      estimatedTokens: 10,
      totalEntryCount: 0,
      includedEntryCount: 0,
      omittedEntryCount: 0,
      abridgedEntryCount: 0,
      gapCount: 0,
      truncated: false,
      documentCodeUnits: document.length,
      document,
    }).truncated).toBe(false);
  });

  it('rejects malformed and relationally inconsistent responses', () => {
    for (const response of [
      { ...VALID, success: false },
      { ...VALID, chatId: 'invalid' },
      { ...VALID, transcriptViewId: '' },
      { ...VALID, generatedAt: 'yesterday' },
      { ...VALID, contextWindowTokens: 1_023 },
      { ...VALID, usableTokenBudget: 98_305 },
      { ...VALID, estimatedTokens: 98_305 },
      { ...VALID, includedEntryCount: 10 },
      { ...VALID, abridgedEntryCount: 10 },
      { ...VALID, gapCount: 4 },
      { ...VALID, omittedEntryCount: 0, includedEntryCount: 12, gapCount: 1 },
      { ...VALID, truncated: false },
      { ...VALID, documentCodeUnits: 6 },
      { ...VALID, document: '<xml/>' },
    ]) {
      expect(() => parseChatHandoffArtifactResponse(response))
        .toThrow(ChatHandoffArtifactContractError);
    }
  });
});
