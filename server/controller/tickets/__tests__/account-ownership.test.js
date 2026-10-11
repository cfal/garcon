import { afterEach, expect, test } from 'bun:test';
import { ticketFixture } from './fixture.js';
import { deriveTicketCaller, ticketFingerprint } from '../contracts.js';
import { parseTicketMutationPayload } from '../../../../common/ticket-commands.js';
import { normalizeStoredTicketRequest } from '../../../../common/ticket-stored.js';

let fixture;
afterEach(() => fixture?.cleanup());
const principal = { mode: 'authenticated', key: 'owner-before', username: 'owner-before',
  credentialRevision: 1, expiresAtMs: Date.now() + 60_000 };

test('fingerprints retain the exact original parser preimage across renames', () => {
  const payload = parseTicketMutationPayload({ action: 'create', input: {
    title: 'Synthetic ticket', project: 'Project', assignee: { kind: 'user', ownerKey: 'owner-before' },
  } });
  // Precomputed with the original username-shaped parser and JSON.stringify([payload, actor]).
  const original = 'd08956bf60a8a3882a362cfecc84409d4c0c84dd856036ca31f132f414892a45';
  expect(ticketFingerprint(payload, deriveTicketCaller(principal))).toBe(original);
  expect(ticketFingerprint(payload, deriveTicketCaller({ ...principal, username: 'owner-after', credentialRevision: 9 }))).toBe(original);
  expect(ticketFingerprint(payload, deriveTicketCaller(principal, '1000000000000001'))).not.toBe(original);
});

test('old ownership, cached results, history and comment authority survive repeated rename without writes on read', () => {
  fixture = ticketFixture();
  const before = deriveTicketCaller(principal);
  const create = fixture.request({ action: 'create', input: { title: 'Synthetic ticket', project: 'Project',
    assignee: { kind: 'user', ownerKey: principal.key } } });
  const created = fixture.service.executeHttp(create, before);
  const comment = fixture.service.executeHttp(fixture.request({ action: 'comment', ticketId: created.ticket.id, body: 'Synthetic comment' }), before).comment;
  const other = fixture.service.executeHttp(fixture.request({ action: 'create', input: { title: 'Related', project: 'Project', assignee: before.owner } }), before);
  const link = fixture.request({ action: 'link', ticketId: created.ticket.id, expectedRevision: 1,
    targetId: other.ticket.id, targetRevision: 1, kind: 'related' });
  fixture.service.executeHttp(link, before);
  const tables = [['tickets', 'payload_json'], ['ticket_activity', 'payload_json'], ['ticket_operations', 'result_json']];
  fixture.store.transaction(database => {
    for (const [table, column] of tables) for (const row of database.query(`SELECT rowid,${column} AS payload FROM ${table}`).all()) {
      database.query(`UPDATE ${table} SET ${column}=? WHERE rowid=?`).run(row.payload.replaceAll('"ownerKey":', '"username":'), row.rowid);
    }
  });
  const snapshot = () => fixture.store.read(database => tables.map(([table, column]) => database.query(`SELECT ${column} FROM ${table}`).all()));
  const stored = snapshot();
  fixture.reopen();
  const after = deriveTicketCaller({ ...principal, username: 'owner-after', credentialRevision: 3 });
  expect(fixture.service.executeHttp(normalizeStoredTicketRequest({ ...create, payload: { ...create.payload,
    input: { ...create.payload.input, assignee: { kind: 'user', username: principal.key } } } }), after)).toEqual(created);
  expect(fixture.service.executeHttp(link, after).relatedTicket.assignee).toEqual(before.owner);
  const detail = fixture.service.read({ ticketId: created.ticket.id }, after.authority);
  expect(detail.ticket.assignee).toEqual(before.owner);
  expect(detail.comments.items[0]).toMatchObject({ canEdit: true, author: { username: 'owner-before' } });
  expect(fixture.service.history({ ticketId: created.ticket.id }).items[0].ticket.assignee).toEqual(before.owner);
  expect(fixture.service.list({ assignee: before.owner }).items).toHaveLength(2);
  expect(snapshot()).toEqual(stored);
  expect(fixture.service.executeHttp(fixture.request({ action: 'comment-edit', ticketId: created.ticket.id,
    commentId: comment.id, expectedRevision: 1, body: 'Edited' }), after).comment.author.username).toBe('owner-before');
  expect(() => fixture.service.executeHttp({ ...create, payload: { ...create.payload, input: { ...create.payload.input, title: 'Changed' } } }, after))
    .toThrow('already used');
  expect(() => fixture.service.executeHttp(fixture.request({ action: 'update', ticketId: created.ticket.id, expectedRevision: 2,
    patch: { assignee: { kind: 'user', ownerKey: after.actor.username } } }), after)).toThrow('current authenticated user');
});
