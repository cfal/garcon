import { expect, test } from 'bun:test';
import { parseIssueSourceResolution } from '../issue-source-navigation.js';
import { issueSource } from '../issue-validation.js';

const source = { chatId: '1000000000000001', transcriptViewId: '11111111-1111-4111-8111-111111111111', ordinal: 7 };

test('round-trips exact issue-source navigation results', () => {
  expect(issueSource(source)).toEqual(source);
  for (const result of [{ kind: 'found', target: source },
    { kind: 'transcript-reloaded', chatId: source.chatId },
    { kind: 'outcome-unavailable', chatId: source.chatId }]) {
    expect(parseIssueSourceResolution(JSON.parse(JSON.stringify(result)))).toEqual(result);
  }
});

test('rejects ambiguous results and invalid addresses', () => {
  for (const value of [null, {}, { kind: 'found' }, { kind: 'missing', chatId: source.chatId },
    { kind: 'found', target: source, chatId: source.chatId },
    { kind: 'outcome-unavailable', chatId: source.chatId, target: source }]) {
    expect(() => parseIssueSourceResolution(value)).toThrow();
  }
  for (const patch of [{ ordinal: 0 }, { ordinal: 1.5 }, { ordinal: Number.MAX_SAFE_INTEGER + 1 },
    { transcriptViewId: 'other' }, { chatId: '../escape' }, { extra: true }]) {
    expect(() => parseIssueSourceResolution({ kind: 'found', target: { ...source, ...patch } })).toThrow();
  }
});
