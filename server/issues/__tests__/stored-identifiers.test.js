import { afterEach, expect, test } from 'bun:test';
import { caller, issueFixture } from './fixture.js';

let fixture;
afterEach(() => fixture?.cleanup());

test('reads original issue snapshots, comments, history and create receipts using G identifiers', () => {
  fixture = issueFixture();
  const request = fixture.request({ action: 'create', input: {
    title: 'Synthetic parent', project: 'Release', description: 'Literal ISS-1 remains authored text.',
  } });
  const original = fixture.service.executeHttp(request, caller);
  const child = fixture.create({ parentId: original.issue.id }).issue;
  fixture.write({ action: 'comment', issueId: child.id, body: 'Literal ISS-2 remains authored text.' });
  fixture.write({ action: 'link', issueId: original.issue.id, expectedRevision: 1,
    targetId: child.id, targetRevision: child.revision, kind: 'related' });
  fixture.write({ action: 'update', issueId: child.id, expectedRevision: 2, patch: { parentId: null } });
  fixture.store.transaction((database) => {
    for (const [table, column] of [
      ['issues', 'payload_json'], ['issue_comments', 'payload_json'],
      ['issue_activity', 'payload_json'], ['issue_operations', 'result_json'],
    ]) {
      const rows = database.query(`SELECT rowid, ${column} AS payload FROM ${table}`).all();
      for (const row of rows) {
        database.query(`UPDATE ${table} SET ${column}=? WHERE rowid=?`)
          .run(row.payload.replace(/"G-([0-9]+)"/gu, '"ISS-$1"'), row.rowid);
      }
    }
  });
  fixture.reopen();
  const detail = fixture.service.read({ issueId: 'G-2' }, caller.authority);
  expect(detail.issue.id).toBe('G-2');
  expect(detail.links[0]).toMatchObject({ sourceId: 'G-1', targetId: 'G-2' });
  expect(detail.comments.items[0]).toMatchObject({ issueId: 'G-2', body: 'Literal ISS-2 remains authored text.' });
  const history = fixture.service.history({ issueId: 'G-2' }).items;
  expect(history.every((event) => event.issueId === 'G-2')).toBe(true);
  expect(history.find((event) => event.action === 'created').issue.parentId).toBe('G-1');
  expect(history.find((event) => event.action === 'updated').changes[0]).toEqual({
    field: 'parentId', before: 'G-1', after: null,
  });
  expect(fixture.service.executeHttp(request, caller)).toEqual(original);
  expect(fixture.service.list({ query: 'G-2' }).items.map((issue) => issue.id)).toEqual(['G-2']);
  expect(fixture.service.read({ issueId: 'G-1' }, caller.authority).issue.description)
    .toBe('Literal ISS-1 remains authored text.');
  const updated = fixture.write({ action: 'update', issueId: 'G-2', expectedRevision: detail.issue.revision,
    patch: { title: 'Synthetic updated child' } });
  expect(updated.issue.id).toBe('G-2');
  expect(fixture.store.read((database) => JSON.parse(database.query('SELECT payload_json FROM issues WHERE number=2').get().payload_json).id)).toBe('G-2');
});
