import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentRuntimeEvent } from '@garcon/server-agent-common/execution/runtime-events';
import { ClaudeCliRuntime } from '../claude-cli.js';
import { ClaudeCliVersionProbe } from '../cli-version.js';
import type { ClaudeStartRequest } from '../runtime-types.js';

const fakeCli = `#!/usr/bin/env bun
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) {
  process.stdout.write('2.1.325\\n');
  process.exit(0);
}
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
const assistant = (text, more) => emit({ type: 'assistant', message: { content: [{ type: 'text', text }] }, ...more });
for await (const line of createInterface({ input: process.stdin })) {
  const input = JSON.parse(line);
  if (input.type === 'control_request') {
    emit({ type: 'control_response', response: { subtype: 'success', request_id: input.request_id, response: { commands: [] } } });
  } else if (input.type === 'user') {
    assistant('Before the input started');
    emit({ type: 'command_lifecycle', state: 'started', command_uuid: input.uuid });
    assistant('History replay', { isReplay: true });
    assistant('Subagent output', { parent_tool_use_id: 'synthetic-subagent' });
    assistant('Owned text');
    emit({ type: 'result', is_error: false, user_message_uuid: input.uuid, result: 'Owned text' });
    emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
  }
}
`;

test.skipIf(process.platform === 'win32')('Claude attributes only fresh non-replay assistant text after the matched input boundary', async () => {
  const temporary = join(homedir(), 'tmp');
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(join(temporary, 'claude-live-origin-'));
  const binary = join(directory, 'synthetic-stdio');
  await writeFile(binary, fakeCli, { mode: 0o700 });
  const runtime = new ClaudeCliRuntime({
    binary: () => binary,
    versionProbe: new ClaudeCliVersionProbe(),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const first: AgentRuntimeEvent[] = [];
  const resumed: AgentRuntimeEvent[] = [];
  const request = {
    agentSessionId: crypto.randomUUID(), chatId: 'chat', command: 'Synthetic input', model: 'haiku',
    projectPath: directory, permissionMode: 'default', thinkingMode: 'none',
    captureLiveOrigin: true,
    operation: { runId: 'fresh', publish: event => { first.push(event); } },
  } satisfies ClaudeStartRequest;
  try {
    await runtime.startClaudeCliSession(request);
    await runtime.runClaudeTurn({ ...request, operation: { runId: 'resumed', publish: event => { resumed.push(event); } } });
    const texts = (events: AgentRuntimeEvent[]) => events.flatMap(event => event.type === 'rows'
      ? event.rows.flatMap(row => row.message.type === 'assistant-message' ? [[row.message.content, event.originRunId]] : []) : []);
    expect(texts(first)).toEqual([['History replay', undefined], ['Owned text', 'fresh']]);
    expect(texts(resumed)).toEqual([['History replay', undefined], ['Owned text', undefined]]);
  } finally { await runtime.shutdown(); await rm(directory, { recursive: true, force: true }); }
});
