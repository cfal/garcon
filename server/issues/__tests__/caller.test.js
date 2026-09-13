import { afterEach, beforeEach, expect, test } from 'bun:test';
import { deriveIssueCaller } from '../contracts.js';
import { issueFixture } from './fixture.js';

let fixture;
beforeEach(() => { fixture = issueFixture(); });
afterEach(() => { fixture.cleanup(); });

test.each(['alice\nadmin', 'alice\0admin', 'alice\u0085admin', 'alice\ud800', 'a'.repeat(257), ' alice '])
('rejects incompatible principal text before it can poison durable issue records: %j', (username) => {
  const principal = { username, key: username, mode: 'authenticated', expiresAtMs: null };
  expect(() => deriveIssueCaller(principal)).toThrow(expect.objectContaining({ code: 'ISSUE_VALIDATION_FAILED' }));
  const caller = { actor: { kind: 'user', username, principalMode: 'authenticated', declaredChatId: null },
    authority: { kind: 'principal', mode: 'authenticated', key: username }, owner: { kind: 'user', username } };
  const request = fixture.request({ action: 'create', input: { title: 'Synthetic', project: 'Synthetic' } });
  expect(() => fixture.service.executeHttp(request, caller)).toThrow(expect.objectContaining({ code: 'ISSUE_VALIDATION_FAILED' }));
  expect(fixture.service.list({}).items).toEqual([]);
  fixture.reopen();
  expect(fixture.create().issue.id).toBe('G-1');
});

test('preserves valid Unicode principal identity through retry and reopen', () => {
  const caller = deriveIssueCaller({ username: '作者:one', key: '作者:one', mode: 'authenticated', expiresAtMs: null });
  const request = fixture.request({ action: 'create', input: { title: 'Synthetic', project: 'Synthetic' } });
  const result = fixture.service.executeHttp(request, caller);
  fixture.reopen();
  expect(fixture.service.executeHttp(request, caller)).toEqual(result);
  expect(fixture.service.list({}).items[0].createdBy.username).toBe('作者:one');
});
