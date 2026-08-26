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
  fold: 'handoff-v1',
  gapUnit: 'eligible-entry',
  sourceEntryCount: 16,
  eligibleEntryCount: 12,
  excludedEntryCounts: [
    { category: 'tool-results', count: 1 },
    { category: 'diagnostics', count: 3 },
  ],
  includedEntryCount: 9,
  budgetOmittedEntryCount: 3,
  abridgedEntryCount: 2,
  gapCount: 2,
  projectionTruncated: true,
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
      sourceEntryCount: 0,
      eligibleEntryCount: 0,
      excludedEntryCounts: [],
      includedEntryCount: 0,
      budgetOmittedEntryCount: 0,
      abridgedEntryCount: 0,
      gapCount: 0,
      projectionTruncated: false,
      documentCodeUnits: document.length,
      document,
    }).projectionTruncated).toBe(false);
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
      { ...VALID, fold: 'other' },
      { ...VALID, gapUnit: 'source-entry' },
      { ...VALID, sourceEntryCount: 15 },
      { ...VALID, excludedEntryCounts: [{ category: 'diagnostics', count: 0 }] },
      { ...VALID, excludedEntryCounts: [
        { category: 'diagnostics', count: 3 },
        { category: 'tool-results', count: 1 },
      ] },
      { ...VALID, includedEntryCount: 10 },
      { ...VALID, abridgedEntryCount: 10 },
      { ...VALID, gapCount: 4 },
      {
        ...VALID,
        budgetOmittedEntryCount: 0,
        includedEntryCount: 12,
        gapCount: 1,
      },
      { ...VALID, projectionTruncated: false },
      { ...VALID, documentCodeUnits: 6 },
      { ...VALID, document: '<xml/>' },
    ]) {
      expect(() => parseChatHandoffArtifactResponse(response))
        .toThrow(ChatHandoffArtifactContractError);
    }
  });
});
