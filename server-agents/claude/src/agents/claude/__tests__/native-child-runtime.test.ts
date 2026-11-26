import { expect, spyOn, test } from 'bun:test';
import { chmod, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentLogger } from '@garcon/server-agent-interface';
import { runtimeOperation, type AgentRuntimeEvent } from '@garcon/server-agent-common/execution/runtime-events';
import { ClaudeCliRuntime } from '../claude-cli.js';
import { ClaudeCliVersionProbe } from '../cli-version.js';
import { ClaudeNativeChildSources } from '../native-child-sources.js';
import type { ClaudeRunningSession } from '../runtime-state.js';

test.each([false, true])('actual stdout isolates malformed child frames and throwing publication: %s', async throwing => {
  const base = path.join(os.homedir(), 'tmp');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'claude-child-runtime-'));
  const binary = path.join(directory, 'synthetic-cli');
  await copyFile(path.join(import.meta.dir, 'fixtures/native-child-cli.ts'), binary);
  await chmod(binary, 0o700);
  const versionProbe = new ClaudeCliVersionProbe();
  spyOn(versionProbe, 'assertCompatible').mockResolvedValue([2, 1, 330]);
  const events: AgentRuntimeEvent[] = [];
  const logger = { debug() {}, info() {}, warn() {}, error() {} } satisfies AgentLogger;
  const runtime = new ClaudeCliRuntime({ binary: () => binary, versionProbe, logger });
  try {
    await runtime.startClaudeCliSession({
      agentSessionId: 'root-a', chatId: 'chat-a', command: 'Synthetic request', projectPath: directory,
      model: 'sonnet', permissionMode: 'default', thinkingMode: 'none',
      nativePath: path.join(directory, 'projects/project-a/root-a.jsonl'),
      envOverrides: { CLAUDE_CONFIG_DIR: directory }, publicationSignal: new AbortController().signal,
      operation: runtimeOperation('run-a', event => {
        events.push(event);
        if (throwing && event.type.startsWith('native-child-')) throw new Error('Synthetic observation failure');
      }),
    });
    expect(events.some(event => event.type === 'native-child-created')).toBe(true);
    expect(events.some(event => event.type === 'native-child-gap')).toBe(true);
    expect(events.filter(event => event.type === 'run-ended')).toMatchObject([{ outcome: 'finished' }]);
    expect(events.filter(event => event.type === 'rows').flatMap(event => event.rows)
      .some(row => row.message.type === 'assistant-message' && row.message.content === 'Synthetic parent answer')).toBe(true);
    expect(runtime.isClaudeInternalSessionRunning('root-a')).toBe(false);
  } finally {
    await runtime.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);

test('confirmed Claude process exit makes stale background activity inert without clearing pending admission', async () => {
  const proc = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore', stderr: 'ignore' });
  const session: ClaudeRunningSession = {
    id: 'root-a', chatId: 'chat-a', process: proc, activeTurn: null, initialization: null,
    completeInitialization: null, lastActivityAt: 0, providerState: 'running', backgroundTaskCount: 1,
    unownedProviderActivity: true, transport: null, retirement: null,
    currentPermissionMode: 'default', currentThinkingMode: 'none', currentClaudeThinkingMode: 'auto', currentModel: 'sonnet',
    options: { agentSessionId: 'root-a', sessionId: 'root-a', chatId: 'chat-a', projectPath: '/synthetic',
      model: 'sonnet', permissionMode: 'default', thinkingMode: 'none' },
  };
  let resumePending = false;
  const sources = new ClaudeNativeChildSources({ session: () => session, isShuttingDown: () => false,
    hasResumeOwner: () => resumePending, hasRetiringWriter: () => false, hasPendingPermission: () => false });
  try { expect(sources.hasNativeWork(session)).toBe(true); }
  finally { proc.kill(); await proc.exited; }
  session.process = null;
  expect(sources.hasNativeWork(session)).toBe(false);
  resumePending = true;
  expect(sources.hasNativeWork(session)).toBe(true);
});
