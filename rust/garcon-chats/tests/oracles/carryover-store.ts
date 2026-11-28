import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentSwitchMessage, AssistantMessage, UserMessage } from '../../../../common/chat-types.js';
import { CarryOverTranscriptStore } from '../../../../server/controller/chats/carryover/transcript-store.ts';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, got ${Bun.version}`);
const [mode, workspaceDir] = process.argv.slice(2);
const id = '11111111-1111-4111-8111-111111111111';
const capturedAt = '2026-01-01T00:00:00.000Z';
const messages = [
  new UserMessage(capturedAt, 'Synthetic question'),
  new AssistantMessage(capturedAt, 'Synthetic answer \u{1f642}'),
];
const refs = [{
  id, agentId: 'a', model: 'alpha', capturedAt, storedMessageCount: 2, visibleMessageCount: 2,
  trailingHandoff: { agentId: 'b', model: 'beta' },
}, {
  id: '22222222-2222-4222-8222-222222222222', agentId: 'b', model: 'beta', capturedAt,
  storedMessageCount: 0, visibleMessageCount: 0, trailingHandoff: { agentId: 'c', model: 'gamma' },
}];
const store = new CarryOverTranscriptStore({ workspaceDir });
await store.initialize();
if (mode === 'write') {
  const prepared = await store.prepareSegment({
    operationId: 'synthetic-op', id, seedSanitation: 'stripped-exact', messages,
  });
  await prepared.commit();
  prepared.releaseRoot();
} else {
  assert.equal(mode, 'read');
}

await store.assertAvailable(refs);
await store.verifySegment(refs[0]);
const full = await store.loadAll(refs);
assert.deepEqual(full, [
  ...messages, new AgentSwitchMessage(capturedAt, 'a', 'b', 'alpha', 'beta'),
  new AgentSwitchMessage(capturedAt, 'b', 'c', 'beta', 'gamma'),
]);
const page = await store.loadPage({ refs, offset: 1, limit: 2 });
const cutoff = store.resolveCutoff(refs, 1);
const path = join(workspaceDir, 'carryover-transcripts', 'segments', id, 'segment.json');
const index = await store.readIndex(id);
assert.equal(await readFile(path, 'utf8'), `${JSON.stringify(index, null, 2)}\n`);
const quarantine = { artifactId: 'synthetic-quarantine', errorCode: 'INVALID_CARRYOVER_ENTRY' };
const quarantinedRevision = store.revision(refs, quarantine);
process.stdout.write(JSON.stringify({ refs, messages, full, page, cutoff, index, quarantine, quarantinedRevision }));
