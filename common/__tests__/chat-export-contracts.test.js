import { describe, expect, it } from 'bun:test';
import {
  TRANSCRIPT_EXPORT_CATEGORIES,
  TRANSCRIPT_EXPORT_CATEGORY_ALIASES,
  TRANSCRIPT_EXPORT_FORMATS,
  canonicalTranscriptExportCategories,
  parseTranscriptExportResponse,
} from '../chat-export-contracts.ts';

const response = {
  success: true,
  chatId: '1787505989127000',
  format: 'markdown',
  transcriptViewId: 'view-1',
  lastOrdinal: 12,
  generatedAt: '2026-08-23T00:00:00.000Z',
  entryCount: 8,
  totalEntryCount: 12,
  exclusions: ['tool-calls', 'tool-results'],
  omitted: [
    { category: 'tool-calls', count: 2 },
    { category: 'tool-results', count: 2 },
  ],
  document: '# Transcript\n',
};

describe('chat export contracts', () => {
  it('defines the closed format, category, and CLI alias vocabularies', () => {
    expect(TRANSCRIPT_EXPORT_FORMATS).toEqual(['markdown', 'xml']);
    expect(TRANSCRIPT_EXPORT_CATEGORIES).toEqual([
      'tool-calls',
      'tool-results',
      'reasoning',
      'permissions',
      'diagnostics',
      'handoffs',
    ]);
    expect(TRANSCRIPT_EXPORT_CATEGORY_ALIASES.tools).toEqual(['tool-calls', 'tool-results']);
    expect(canonicalTranscriptExportCategories([
      'handoffs',
      'tool-results',
      'tool-calls',
      'tool-results',
    ])).toEqual(['tool-calls', 'tool-results', 'handoffs']);
  });

  it('parses a relationally valid export response', () => {
    expect(parseTranscriptExportResponse(response)).toEqual(response);
  });

  it('rejects malformed and relationally inconsistent responses', () => {
    expect(() => parseTranscriptExportResponse({ ...response, success: false })).toThrow();
    expect(() => parseTranscriptExportResponse({ ...response, format: 'json' })).toThrow();
    expect(() => parseTranscriptExportResponse({ ...response, chatId: 'bad' })).toThrow();
    expect(() => parseTranscriptExportResponse({ ...response, exclusions: ['tools'] })).toThrow();
    expect(() => parseTranscriptExportResponse({
      ...response,
      exclusions: ['tool-results', 'tool-calls'],
    })).toThrow();
    expect(() => parseTranscriptExportResponse({
      ...response,
      omitted: [{ category: 'tool-calls', count: 4 }],
    })).toThrow();
    expect(() => parseTranscriptExportResponse({ ...response, document: '# Transcript' })).toThrow();
  });
});
