import { describe, expect, test } from 'bun:test';
import { TICKET_ACTIONS } from '../ticket-commands.js';
import { garconTicketResultContent, ticketCommandOutcome, ticketCommandContext, ticketMutationReceipt,
  parseGarconTicketResult, parseTicketCommandOutcome, parseTicketCommandResult } from '../garcon-ticket-result.js';
import { TICKET_LIMITS } from '../tickets.js';
import { ticketBytes } from '../ticket-validation.js';
import { parseGarconTicketCommand } from '../garcon-ticket-command.js';
import { ticketCommandNoticeParts, ticketCommandNoticeText } from '../ticket-command-notice.js';
import { escapeGarconXmlText } from '../garcon-command-envelope.js';

const version = { storeId: '11111111-1111-4111-8111-111111111111', collectionRevision: 7 };
const correlation = { requestViewId: '22222222-2222-4222-8222-222222222222', requestOrdinal: 12 };
const actor = { kind: 'chat', chatId: '1000000000000001', provenance: 'observed' };
const ticket = { id: 'G-1', number: 1, revision: 1, title: 'Synthetic <title>', description: 'Synthetic <garcon-ticket-list />',
  project: 'Project & one', status: 'open', resolution: null, priority: 2, labels: [], assignee: null, parentId: null,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', createdBy: actor };
const comment = { id: '33333333-3333-4333-8333-333333333333', ticketId: ticket.id, sequence: 1, revision: 1,
  body: 'Synthetic <comment>', author: actor, createdAt: ticket.createdAt, updatedAt: ticket.createdAt, deletedAt: null };
const write = { success: true, ...version, ticket, comment };
const { description: _description, ...summary } = ticket;
const reads = {
  list: { ...version, items: [{ ...summary, blockedByCount: 0, commentCount: 1 }], nextBeforeNumber: null },
  read: { ...version, ticket, links: [], comments: { ...version, items: [{ ...comment, canEdit: true }], nextBeforeSequence: null } },
  history: { ...version, items: [{ sequence: 1, ticketId: ticket.id, at: ticket.createdAt, actor,
    source: { chatId: actor.chatId, transcriptViewId: correlation.requestViewId, ordinal: 1 },
    action: 'created', ticket }], nextBeforeSequence: null },
};

function result(command, status = 'ok') {
  return { command, ...correlation, ...(!reads[command] ? { ref: 'write "one" & two' } : {}),
    ...(command !== 'list' && (command !== 'create' || status === 'ok') ? { ticketId: ticket.id } : {}),
    ...(status === 'ok' ? { status, data: reads[command] ?? ticketMutationReceipt(write) }
      : { status, errorCode: 'TICKET_NOT_FOUND', message: 'Synthetic ticket unavailable.' }) };
}

describe('command-specific ticket results', () => {
  test.each([
    ['create', 'Created ticket G-1'], ['update', 'Updated ticket G-1'],
    ['claim', 'Assigned ticket G-1 to this chat'], ['release', 'Released ticket G-1'],
    ['reopen', 'Reopened ticket G-1'], ['close', 'Closed ticket G-1'],
    ['comment', 'Added comment to ticket G-1'], ['comment-edit', 'Edited comment on ticket G-1'],
    ['comment-delete', 'Deleted comment from ticket G-1'], ['list', 'Listed tickets'],
    ['read', 'Read ticket G-1'], ['history', 'Read history for ticket G-1'],
    ['link', 'G-1 updated, added link'], ['unlink', 'G-1 updated, removed link'],
  ])('describes %s without a redundant title', (command, expected) => {
    expect(ticketCommandNoticeText(ticketCommandOutcome(result(command)))).toBe(expected);
    const failure = ticketCommandNoticeText(ticketCommandOutcome(result(command, 'error')));
    expect(failure).toStartWith("Couldn't ");
    expect(failure).toContain('TICKET_NOT_FOUND');
    expect(failure).not.toContain('completed');
    if (command !== 'list' && command !== 'create') expect(failure).toContain('G-1');
  });

  test.each(['link', 'unlink'])('preserves both targets and relationship direction for %s', (command) => {
    for (const kind of ['blocks', 'related']) for (const status of ['ok', 'error']) {
      const context = ticketCommandContext(parseGarconTicketCommand(
        `<garcon-ticket-${command} ref="link" ticket-id="G-1" expected-revision="1">{"kind":"${kind}","targetId":"G-2","targetRevision":1}</garcon-ticket-${command}>`,
      ));
      const output = { ...result(command, status), context };
      expect(parseGarconTicketResult(garconTicketResultContent(output))).toEqual(output);
      const outcome = ticketCommandOutcome(output);
      expect(parseTicketCommandOutcome(outcome)).toEqual(outcome);
      expect(ticketCommandNoticeParts(outcome).filter((part) => part.kind === 'ticket'))
        .toEqual([{ kind: 'ticket', ticketId: 'G-1' }, { kind: 'ticket', ticketId: 'G-2' }]);
      const label = kind === 'blocks' ? 'blocking' : 'related';
      expect(ticketCommandNoticeText(outcome)).toBe(status === 'ok'
        ? `G-1 updated, ${command === 'link' ? 'added' : 'removed'} ${label} link to G-2`
        : `Couldn't ${command === 'link' ? 'add' : 'remove'} ${label} link from G-1 to G-2: "TICKET_NOT_FOUND"`);
    }
  });

  test('round-trips bounded list filters without pagination or Markdown interpretation', () => {
    const filters = { project: 'Synthetic `<path> & [link](https://example.test)', priority: 0,
      status: 'in-progress', includeClosed: true, ready: false, label: 'ui', query: 'G-2',
      assignee: { kind: 'chat', chatId: actor.chatId } };
    const command = parseGarconTicketCommand(`<garcon-ticket-list>${escapeGarconXmlText(JSON.stringify({ ...filters,
      limit: 1, beforeNumber: 3, expectedCollectionRevision: 7 }))}</garcon-ticket-list>`);
    expect(command).not.toBeNull();
    const context = ticketCommandContext(command);
    expect(context).toEqual({ filters });
    for (const status of ['ok', 'error']) {
      const output = { ...result('list', status), context };
      expect(parseGarconTicketResult(garconTicketResultContent(output))).toEqual(output);
      const outcome = ticketCommandOutcome(output);
      expect(parseTicketCommandOutcome(outcome)).toEqual(outcome);
      expect(ticketCommandNoticeParts(outcome)).toContainEqual({ kind: 'code', text: filters.project });
      const prefix = status === 'ok' ? 'Listed tickets' : "Couldn't list tickets";
      const suffix = status === 'error' ? ': "TICKET_NOT_FOUND"' : '';
      expect(ticketCommandNoticeText(outcome)).toBe(`${prefix} with filters project ${JSON.stringify(filters.project)}, status "in progress", include closed "true", priority "urgent", label "ui", assignee "chat ${actor.chatId}", ready "false", search "G-2"${suffix}`);
      expect(ticketCommandNoticeText(outcome)).not.toContain('limit');
    }
    expect(ticketCommandContext(parseGarconTicketCommand('<garcon-ticket-list />'))).toEqual({ filters: {} });
    expect(ticketCommandNoticeText(ticketCommandOutcome({ ...result('list'), context: { filters: {} } }))).toBe('Listed tickets');
  });

  test.each([
    ['unassigned', 'unassigned'],
    [{ kind: 'user', username: 'synthetic-user' }, 'synthetic-user'],
    [{ kind: 'chat', chatId: actor.chatId }, `chat ${actor.chatId}`],
  ])('formats the list assignee %j without changing its identity', (assignee, expected) => {
    const outcome = ticketCommandOutcome({ ...result('list'), context: { filters: { assignee } } });
    expect(ticketCommandNoticeText(outcome)).toBe(`Listed tickets with filters assignee ${JSON.stringify(expected)}`);
    expect(ticketCommandNoticeParts(outcome)).toEqual([
      { kind: 'text', text: 'Listed tickets' },
      { kind: 'text', text: ' with filters assignee ' },
      { kind: 'code', text: expected },
    ]);
  });

  test('rejects context on the wrong action, unbounded values and private fields', () => {
    for (const [command, context] of [
      ['create', { filters: {} }], ['list', { link: { kind: 'blocks', targetId: 'G-2' } }],
      ['list', { filters: { limit: 1 } }], ['list', { filters: { project: 'a'.repeat(4097) } }],
      ['list', { filters: { priority: 4 } }], ['list', { filters: { assignee: { kind: 'admin' } } }],
      ['link', { link: { kind: 'parent', targetId: 'G-2' } }],
      ['link', { link: { kind: 'blocks', targetId: 'javascript:evil' } }],
      ['link', { link: { kind: 'blocks', targetId: 'G-2', body: 'private' } }],
    ]) {
      const output = { ...result(command), context };
      expect(() => parseTicketCommandResult(output)).toThrow();
      expect(parseGarconTicketResult(garconTicketResultContent(output))).toBeNull();
      expect(parseTicketCommandOutcome(ticketCommandOutcome(output))).toBeNull();
    }
  });

  test('uses only ticket names for result envelopes and notices', () => {
    for (const command of TICKET_ACTIONS) for (const status of ['ok', 'error']) {
      const expected = result(command, status);
      const content = garconTicketResultContent(expected);
      expect(parseGarconTicketResult(content.replaceAll('garcon-ticket-', 'garcon-issue-'))).toBeNull();
      const outcome = ticketCommandOutcome(expected);
      expect(outcome.type).toBe('ticket-command-outcome');
      expect(parseTicketCommandOutcome({ ...outcome, type: 'issue-command-outcome' })).toBeNull();
    }
  });

  test('normalizes legacy stored results and notices without changing their correlation', () => {
    for (const command of TICKET_ACTIONS) for (const status of ['ok', 'error']) {
      const expected = result(command, status);
      const legacy = JSON.parse(JSON.stringify(expected).replace(/"G-([0-9]+)"/gu, '"ISS-$1"'));
      expect(parseTicketCommandResult(legacy)).toEqual(expected);
      expect(parseGarconTicketResult(garconTicketResultContent(legacy))).toEqual(expected);
      const outcome = ticketCommandOutcome(expected);
      const legacyOutcome = JSON.parse(JSON.stringify(outcome).replace(/"G-([0-9]+)"/gu, '"ISS-$1"'));
      expect(parseTicketCommandOutcome(legacyOutcome)).toEqual(outcome);
    }
  });

  test('round-trips every success and failure with exact correlation and one XML decoding', () => {
    for (const command of TICKET_ACTIONS) for (const status of ['ok', 'error']) {
      const expected = result(command, status);
      const content = garconTicketResultContent(expected);
      expect(content.startsWith(`<garcon-ticket-${command}-result `)).toBe(true);
      expect(content).not.toContain(' command=');
      expect(content).not.toContain('request-id=');
      expect(parseGarconTicketResult(content)).toEqual(expected);
      expect(parseTicketCommandResult(expected)).toEqual(expected);
      const outcome = ticketCommandOutcome(expected);
      expect(parseTicketCommandOutcome(outcome)).toEqual(outcome);
      expect(outcome).not.toHaveProperty('data');
      expect(outcome).not.toHaveProperty('message');
    }
    const content = garconTicketResultContent(result('read'));
    expect(content).not.toContain('<garcon-ticket-list />');
    expect(content).toContain('&lt;garcon-ticket-list /&gt;');
    expect(content).not.toContain(' ref=');
  });

  test('keeps maximum mutation results compact and drops authored bodies from notices', () => {
    const large = { ...write, ticket: { ...ticket, description: '<'.repeat(TICKET_LIMITS.bodyBytes) },
      comment: { ...comment, body: '&'.repeat(TICKET_LIMITS.bodyBytes) }, relatedTicket: ticket };
    const receipt = ticketMutationReceipt(large);
    expect(receipt).toEqual({ ...version, ticketId: ticket.id, revision: 1, status: 'open',
      comment: { id: comment.id, revision: 1 }, relatedTicket: { id: ticket.id, revision: 1 } });
    const output = { ...result('close'), data: receipt };
    expect(ticketBytes(garconTicketResultContent(output))).toBeLessThan(1024);
    expect(ticketCommandOutcome(output)).toEqual({ type: 'ticket-command-outcome', ...correlation,
      command: 'close', ref: output.ref, ticketId: ticket.id, status: 'ok', revision: 1 });
    expect(parseTicketCommandOutcome({ ...ticketCommandOutcome(output), nativeResultInput: true })).toBeNull();
    expect(parseTicketCommandOutcome({ ...ticketCommandOutcome(output), data: large })).toBeNull();
  });

  test('rejects mismatched identity, unsupported tags and malformed public projections', () => {
    const valid = result('create');
    for (const invalid of [{ ...valid, ref: undefined }, { ...valid, ticketId: 'G-2' },
      { ...valid, data: { ...valid.data, storeId: 'invalid' } }, { ...valid, requestOrdinal: 0 },
      { ...result('list'), ticketId: 'G-1' }, { ...result('read'), ticketId: 'G-2' },
      { ...result('history'), ticketId: 'G-2' }, { ...valid, authority: 'forged' },
      { ...result('read', 'error'), data: reads.read },
      { ...result('read', 'error'), errorCode: 'UNKNOWN_ERROR' }]) {
      expect(() => parseTicketCommandResult(invalid)).toThrow();
    }
    const xml = garconTicketResultContent(valid);
    expect(parseGarconTicketResult(xml.replaceAll('garcon-ticket-create-result', 'garcon-ticket-result'))).toBeNull();
    expect(parseGarconTicketResult(xml.replace('request-ordinal="12"', 'request-ordinal="1e2"'))).toBeNull();
    expect(parseGarconTicketResult(xml.replace('status="ok"', 'status="ok" extra="x"'))).toBeNull();
    const outcome = ticketCommandOutcome(result('list'));
    expect(parseTicketCommandOutcome({ ...outcome, revision: 1 })).toBeNull();
    expect(parseTicketCommandOutcome({ ...ticketCommandOutcome(valid), ticketId: undefined })).toBeNull();
  });

  test('enforces final escaped bytes and provides an explicit metadata-only projection', () => {
    const full = { ...result('read'), data: { ...reads.read, ticket: { ...ticket, description: '<'.repeat(13000) } } };
    const encoded = garconTicketResultContent(full);
    expect(ticketBytes(JSON.stringify(full))).toBeLessThan(TICKET_LIMITS.markupBytes);
    expect(ticketBytes(encoded)).toBeGreaterThan(TICKET_LIMITS.markupBytes);
    expect(parseGarconTicketResult(encoded)).toBeNull();
    const metadata = { ...full, data: { ...full.data, ticket: { ...ticket, description: null },
      comments: { ...version, items: [], nextBeforeSequence: null } } };
    expect(parseGarconTicketResult(garconTicketResultContent(metadata))).toEqual(metadata);
  });
});
