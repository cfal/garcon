import { randomUUID } from 'node:crypto';
import {
  accessSync,
  appendFileSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const MAX_SANITIZED_LENGTH = 200;
const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log('2.1.220 (Claude Code)');
} else if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'api_key' }));
} else {
  await runStreamSession();
}

async function runStreamSession(): Promise<void> {
  const sessionId = argumentValue('--session-id') ?? argumentValue('--resume');
  if (!sessionId) {
    await runInitializeProbe();
    return;
  }

  const nativePath = claudeNativePath(process.cwd(), sessionId);
  const isResume = argumentValue('--resume') !== null;
  if (isResume) {
    try {
      accessSync(nativePath);
    } catch {
      console.error(`No conversation found with session ID: ${sessionId}`);
      process.exitCode = 1;
      return;
    }
  } else {
    initializeSessionArtifacts(nativePath, sessionId);
  }

  writeOutput({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: argumentValue('--model') ?? 'claude-haiku-4-5-20251001',
    slash_commands: [],
    capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1'],
  });

  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of Bun.stdin.stream()) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      handleInput(buffered.slice(0, newline), nativePath, sessionId);
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
    }
  }
  buffered += decoder.decode();
  if (buffered.trim()) handleInput(buffered, nativePath, sessionId);
}

async function runInitializeProbe(): Promise<void> {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of Bun.stdin.stream()) {
    buffered += decoder.decode(chunk, { stream: true });
    const newline = buffered.indexOf('\n');
    if (newline < 0) continue;
    const input = JSON.parse(buffered.slice(0, newline)) as {
      type?: string;
      request_id?: string;
      request?: { subtype?: string };
    };
    if (input.type === 'control_request' && input.request?.subtype === 'initialize') {
      writeOutput({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: input.request_id,
          response: { commands: [] },
        },
      });
    }
    return;
  }
}

function argumentValue(name: string): string | null {
  const inline = args.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 && typeof args[index + 1] === 'string'
    ? args[index + 1]!
    : null;
}

function initializeSessionArtifacts(nativePath: string, sessionId: string): void {
  const projectDirectory = resolve(nativePath, '..');
  mkdirSync(join(projectDirectory, sessionId, 'subagents'), { recursive: true });
  writeFileSync(nativePath, '');
  writeFileSync(join(projectDirectory, `${sessionId}.queue.json`), '{"queued":[]}\n');
  writeFileSync(
    join(projectDirectory, sessionId, 'subagents', 'agent-integration.jsonl'),
    `${JSON.stringify({ sessionId, type: 'summary', summary: 'integration support artifact' })}\n`,
  );
}

function handleInput(line: string, nativePath: string, sessionId: string): void {
  if (!line.trim()) return;
  const input = JSON.parse(line) as {
    type?: string;
    request_id?: string;
    request?: { subtype?: string };
    uuid?: string;
    message?: { role?: string; content?: unknown };
  };
  if (
    input.type === 'control_request'
    && (input.request?.subtype === 'initialize' || input.request?.subtype === 'set_model')
  ) {
    writeOutput({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: input.request_id,
        response: { commands: [], capabilities: ['interrupt_cancel_queued_v1'] },
      },
    });
    return;
  }
  if (input.type !== 'user' || input.message?.role !== 'user') return;
  if (!input.uuid) throw new Error('Claude stream input requires a command UUID');

  const prompt = messageText(input.message.content);
  const response = `echo:${prompt}`;
  const userTimestamp = new Date().toISOString();
  const assistantTimestamp = new Date(Date.now() + 1).toISOString();
  appendFileSync(nativePath, [
    JSON.stringify({
      sessionId,
      type: 'user',
      uuid: input.uuid,
      timestamp: userTimestamp,
      cwd: process.cwd(),
      message: { role: 'user', content: prompt },
    }),
    JSON.stringify({
      sessionId,
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: assistantTimestamp,
      cwd: process.cwd(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: response }],
      },
    }),
    '',
  ].join('\n'));

  writeOutput({
    type: 'command_lifecycle',
    command_uuid: input.uuid,
    state: 'queued',
    session_id: sessionId,
  });
  writeOutput({
    type: 'system',
    subtype: 'session_state_changed',
    state: 'running',
    session_id: sessionId,
  });
  writeOutput({
    type: 'command_lifecycle',
    command_uuid: input.uuid,
    state: 'started',
    session_id: sessionId,
  });
  writeOutput({
    type: 'user',
    uuid: input.uuid,
    isReplay: true,
    message: input.message,
    session_id: sessionId,
  });
  writeOutput({
    type: 'assistant',
    session_id: sessionId,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: response }],
    },
  });
  writeOutput({
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    is_error: false,
    duration_ms: 1,
    num_turns: 1,
    result: response,
  });
  writeOutput({
    type: 'command_lifecycle',
    command_uuid: input.uuid,
    state: 'completed',
    session_id: sessionId,
  });
  writeOutput({
    type: 'system',
    subtype: 'session_state_changed',
    state: 'idle',
    session_id: sessionId,
  });
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part) => (
      part
      && typeof part === 'object'
      && !Array.isArray(part)
      && (part as { type?: unknown }).type === 'text'
      && typeof (part as { text?: unknown }).text === 'string'
        ? [(part as { text: string }).text]
        : []
    ))
    .join('\n');
}

function claudeNativePath(projectPath: string, sessionId: string): string {
  const configHome = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const canonicalProjectPath = resolve(projectPath).normalize('NFC');
  const sanitized = canonicalProjectPath.replace(/[^a-zA-Z0-9]/g, '-');
  const projectKey = sanitized.length <= MAX_SANITIZED_LENGTH
    ? sanitized
    : `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${simpleHash(canonicalProjectPath)}`;
  return join(configHome.normalize('NFC'), 'projects', projectKey, `${sessionId}.jsonl`);
}

function simpleHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function writeOutput(value: unknown): void {
  console.log(JSON.stringify(value));
}
