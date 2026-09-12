import { describe, expect, test } from 'bun:test';
import { ISSUE_ACTIONS } from '../issue-commands.js';
import { garconIssueResultContent, issueCommandOutcome, issueMutationReceipt,
  parseGarconIssueResult, parseIssueCommandOutcome, parseIssueCommandResult } from '../garcon-issue-result.js';
import { ISSUE_LIMITS } from '../issues.js';
import { issueBytes } from '../issue-validation.js';

const version = { storeId: '11111111-1111-4111-8111-111111111111', collectionRevision: 7 };
const correlation = { requestViewId: '22222222-2222-4222-8222-222222222222', requestOrdinal: 12 };
const actor = { kind: 'chat', chatId: '1000000000000001', provenance: 'observed' };
const issue = { id: 'ISS-1', number: 1, revision: 1, title: 'Synthetic <title>', description: 'Synthetic <garcon-issue-list />',
  project: 'Project & one', status: 'open', resolution: null, priority: 2, labels: [], assignee: null, parentId: null,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', createdBy: actor };
const comment = { id: '33333333-3333-4333-8333-333333333333', issueId: issue.id, sequence: 1, revision: 1,
  body: 'Synthetic <comment>', author: actor, createdAt: issue.createdAt, updatedAt: issue.createdAt, deletedAt: null };
const write = { success: true, ...version, issue, comment };
const { description: _description, ...summary } = issue;
const reads = {
  list: { ...version, items: [{ ...summary, blockedByCount: 0, commentCount: 1 }], nextBeforeNumber: null },
  read: { ...version, issue, links: [], comments: { ...version, items: [{ ...comment, canEdit: true }], nextBeforeSequence: null } },
  history: { ...version, items: [{ sequence: 1, issueId: issue.id, at: issue.createdAt, actor,
    source: { chatId: actor.chatId, transcriptViewId: correlation.requestViewId, ordinal: 1 },
    action: 'created', issue }], nextBeforeSequence: null },
};

function result(command, status = 'ok') {
  return { command, ...correlation, ...(!reads[command] ? { ref: 'write "one" & two' } : {}),
    ...(command !== 'list' && (command !== 'create' || status === 'ok') ? { issueId: issue.id } : {}),
    ...(status === 'ok' ? { status, data: reads[command] ?? issueMutationReceipt(write) }
      : { status, errorCode: 'ISSUE_NOT_FOUND', message: 'Synthetic issue unavailable.' }) };
}

describe('command-specific issue results', () => {
  test('round-trips every success and failure with exact correlation and one XML decoding', () => {
    for (const command of ISSUE_ACTIONS) for (const status of ['ok', 'error']) {
      const expected = result(command, status);
      const content = garconIssueResultContent(expected);
      expect(content.startsWith(`<garcon-issue-${command}-result `)).toBe(true);
      expect(content).not.toContain(' command=');
      expect(content).not.toContain('request-id=');
      expect(parseGarconIssueResult(content)).toEqual(expected);
      expect(parseIssueCommandResult(expected)).toEqual(expected);
      const outcome = issueCommandOutcome(expected);
      expect(parseIssueCommandOutcome(outcome)).toEqual(outcome);
      expect(outcome).not.toHaveProperty('data');
      expect(outcome).not.toHaveProperty('message');
    }
    const content = garconIssueResultContent(result('read'));
    expect(content).not.toContain('<garcon-issue-list />');
    expect(content).toContain('&lt;garcon-issue-list /&gt;');
    expect(content).not.toContain(' ref=');
  });

  test('keeps maximum mutation results compact and drops authored bodies from notices', () => {
    const large = { ...write, issue: { ...issue, description: '<'.repeat(ISSUE_LIMITS.bodyBytes) },
      comment: { ...comment, body: '&'.repeat(ISSUE_LIMITS.bodyBytes) }, relatedIssue: issue };
    const receipt = issueMutationReceipt(large);
    expect(receipt).toEqual({ ...version, issueId: issue.id, revision: 1, status: 'open',
      comment: { id: comment.id, revision: 1 }, relatedIssue: { id: issue.id, revision: 1 } });
    const output = { ...result('close'), data: receipt };
    expect(issueBytes(garconIssueResultContent(output))).toBeLessThan(1024);
    expect(issueCommandOutcome(output)).toEqual({ type: 'issue-command-outcome', ...correlation,
      command: 'close', ref: output.ref, issueId: issue.id, status: 'ok', revision: 1 });
    expect(parseIssueCommandOutcome({ ...issueCommandOutcome(output), nativeResultInput: true })).toBeNull();
    expect(parseIssueCommandOutcome({ ...issueCommandOutcome(output), data: large })).toBeNull();
  });

  test('rejects mismatched identity, unsupported tags and malformed public projections', () => {
    const valid = result('create');
    for (const invalid of [{ ...valid, ref: undefined }, { ...valid, issueId: 'ISS-2' },
      { ...valid, data: { ...valid.data, storeId: 'invalid' } }, { ...valid, requestOrdinal: 0 },
      { ...result('list'), issueId: 'ISS-1' }, { ...result('read'), issueId: 'ISS-2' },
      { ...result('history'), issueId: 'ISS-2' }, { ...valid, authority: 'forged' },
      { ...result('read', 'error'), data: reads.read },
      { ...result('read', 'error'), errorCode: 'UNKNOWN_ERROR' }]) {
      expect(() => parseIssueCommandResult(invalid)).toThrow();
    }
    const xml = garconIssueResultContent(valid);
    expect(parseGarconIssueResult(xml.replaceAll('garcon-issue-create-result', 'garcon-issue-result'))).toBeNull();
    expect(parseGarconIssueResult(xml.replace('request-ordinal="12"', 'request-ordinal="1e2"'))).toBeNull();
    expect(parseGarconIssueResult(xml.replace('status="ok"', 'status="ok" extra="x"'))).toBeNull();
    const outcome = issueCommandOutcome(result('list'));
    expect(parseIssueCommandOutcome({ ...outcome, revision: 1 })).toBeNull();
    expect(parseIssueCommandOutcome({ ...issueCommandOutcome(valid), issueId: undefined })).toBeNull();
  });

  test('enforces final escaped bytes and provides an explicit metadata-only projection', () => {
    const full = { ...result('read'), data: { ...reads.read, issue: { ...issue, description: '<'.repeat(13000) } } };
    const encoded = garconIssueResultContent(full);
    expect(issueBytes(JSON.stringify(full))).toBeLessThan(ISSUE_LIMITS.markupBytes);
    expect(issueBytes(encoded)).toBeGreaterThan(ISSUE_LIMITS.markupBytes);
    expect(parseGarconIssueResult(encoded)).toBeNull();
    const metadata = { ...full, data: { ...full.data, issue: { ...issue, description: null },
      comments: { ...version, items: [], nextBeforeSequence: null } } };
    expect(parseGarconIssueResult(garconIssueResultContent(metadata))).toEqual(metadata);
  });
});
