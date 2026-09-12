import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { IssueStore } from '../store.js';
import { IssueService } from '../service.js';
import { deriveIssueCaller, markupIssueContext } from '../contracts.js';
import { parseMarkupIssueMutationPayload } from '../../../common/issue-commands.js';

export const CHAT_ID = '1000000000000001';
export const OTHER_CHAT_ID = '1000000000000002';
export const VIEW_ID = '22222222-2222-4222-8222-222222222222';
export const principal = { mode: 'local', key: 'local', username: 'local', expiresAtMs: null };
export const caller = deriveIssueCaller(principal);

export function issueFixture() {
  const directory = mkdtempSync(join(homedir(), 'garcon-issues-test-'));
  const chats = new Set([CHAT_ID, OTHER_CHAT_ID]);
  const invalidations = [];
  const controls = { enabled: true, failCommit: false, failListener: false, now: '2026-01-01T00:00:00.000Z' };
  const options = { chatExists: (id) => chats.has(id), commandsEnabled: () => controls.enabled,
    now: () => controls.now, onInvalidated(revision) {
      invalidations.push(revision);
      if (controls.failListener) throw new Error('Synthetic listener failure');
    } };
  let store = new IssueStore(directory, { beforeCommit() {
    if (controls.failCommit) throw new Error('Synthetic commit failure');
  } });
  let service = new IssueService(store, options);
  return {
    directory, chats, controls, invalidations,
    get store() { return store; },
    get service() { return service; },
    request(payload, overrides = {}) {
      return { requestId: crypto.randomUUID(), expectedStoreId: service.storeId, payload, ...overrides };
    },
    write(payload, overrides = {}) {
      const request = this.request(payload, overrides);
      return service.executeHttp(request, deriveIssueCaller(principal, request.fromChatId));
    },
    create(input = {}) { return this.write({ action: 'create', input: { title: 'Synthetic issue', project: 'Test project', ...input } }); },
    markup(payload, ref, chatId = CHAT_ID) {
      const normalized = parseMarkupIssueMutationPayload(payload);
      const context = markupIssueContext(service.storeId, { chatId, transcriptViewId: VIEW_ID, ordinal: 1 }, ref, normalized);
      return service.execute(normalized, context);
    },
    reopen() {
      service.close();
      store = new IssueStore(directory);
      service = new IssueService(store, options);
    },
    cleanup() { service.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
