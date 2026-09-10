import { writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ChatRegistry } from '../server/chats/store.js';
import { ExecutionNodesStore } from '../server/execution-nodes/store.js';

export const SMOKE_CHAT_ID = '1767225600000000';
export const SMOKE_SEARCH_TOKEN = 'embeddedworkertoken';

export async function seedSmokeAccount(configDirectory) {
  const account = { username: 'synthetic-user', password: randomBytes(32).toString('base64url') };
  await writeFile(join(configDirectory, 'auth.json'), JSON.stringify({
    username: account.username,
    passwordHash: await Bun.password.hash(account.password, { algorithm: 'bcrypt', cost: 4 }),
    createdAt: '2026-01-01T00:00:00.000Z',
  }), { mode: 0o600 });
  return account;
}

export async function seedSmokeTranscript(workspaceDir) {
  await writeFile(join(workspaceDir, 'project-settings.json'),
    JSON.stringify({ features: { transcriptSearch: { enabled: true } } }));
  const transcriptPath = join(workspaceDir, 'smoke-session.jsonl');
  await writeFile(transcriptPath, `${JSON.stringify({
    sessionId: 'smoke-session', uuid: 'smoke-user-message', type: 'user',
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: SMOKE_SEARCH_TOKEN },
  })}\n`);

  const nodes = new ExecutionNodesStore(workspaceDir);
  await nodes.init();
  const [executionLocation] = await nodes.prepareLocalTargets([{ agentId: 'claude', projectPath: workspaceDir }]);
  const registry = new ChatRegistry(workspaceDir);
  await registry.init();
  registry.addChat({
    id: SMOKE_CHAT_ID, agentId: 'claude', model: 'fable', projectPath: workspaceDir, executionLocation,
    nativeSession: { ownerId: 'claude', schemaVersion: 1,
      value: { path: transcriptPath, agentSessionId: 'smoke-session' } },
    agentSessionId: 'smoke-session', agentOwnershipEpoch: 'smoke-ownership-epoch',
    agentSettingsById: { claude: { ownerId: 'claude', schemaVersion: 1, values: {} } },
    preambleSelection: { revision: 0, orderedPreambleIds: [] }, parentChat: null,
  });
  await registry.flush();
}
