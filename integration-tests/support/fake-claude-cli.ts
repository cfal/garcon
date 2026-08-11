import { randomUUID } from 'node:crypto';
import {
  accessSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const MAX_SANITIZED_LENGTH = 200;
const args = process.argv.slice(2);
let heldInput: {
  uuid: string;
  sessionId: string;
} | null = null;
let heldAbortPoll: ReturnType<typeof setInterval> | null = null;

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
  if (input.type === 'control_request' && input.request?.subtype === 'interrupt') {
    writeOutput({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: input.request_id,
        response: { cancelled: [], still_queued: [] },
      },
    });
    const interruptPath = process.env.CLAUDE_TEST_INTERRUPT_PATH;
    if (interruptPath) appendFileSync(interruptPath, 'interrupt\n');
    scheduleHeldAbortSettlement();
    return;
  }
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
  const assistantUuid = randomUUID();
  if (process.env.CLAUDE_TEST_STREAM_PROMPT === prompt) {
    streamActiveTurn({
      sessionId,
      nativePath,
      uuid: input.uuid,
      message: input.message,
      prompt,
      response,
      userTimestamp,
    });
    return;
  }
  if (process.env.CLAUDE_TEST_HOLD_ACTIVE === '1') {
    appendFileSync(nativePath, `${JSON.stringify({
      sessionId,
      type: 'user',
      uuid: input.uuid,
      timestamp: userTimestamp,
      cwd: process.cwd(),
      message: { role: 'user', content: prompt },
    })}\n`);
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
    heldInput = { uuid: input.uuid, sessionId };
    const startedPath = process.env.CLAUDE_TEST_STARTED_PATH;
    if (startedPath) writeFileSync(startedPath, `${input.uuid}\n`);
    return;
  }
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
      uuid: assistantUuid,
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
    uuid: assistantUuid,
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

// Mirrors a turn whose assistant output reaches the stream before the CLI appends it to the
// transcript. The turn stays active until the release file appears, so tests can observe forks
// against a chat whose view has outrun native history.
function streamActiveTurn(turn: {
  sessionId: string;
  nativePath: string;
  uuid: string;
  message: { role?: string; content?: unknown };
  prompt: string;
  response: string;
  userTimestamp: string;
}): void {
  const streamedAssistantUuid = randomUUID();
  appendFileSync(turn.nativePath, `${JSON.stringify({
    sessionId: turn.sessionId,
    type: 'user',
    uuid: turn.uuid,
    timestamp: turn.userTimestamp,
    cwd: process.cwd(),
    message: { role: 'user', content: turn.prompt },
  })}\n`);
  writeOutput({
    type: 'command_lifecycle',
    command_uuid: turn.uuid,
    state: 'queued',
    session_id: turn.sessionId,
  });
  writeOutput({
    type: 'system',
    subtype: 'session_state_changed',
    state: 'running',
    session_id: turn.sessionId,
  });
  writeOutput({
    type: 'command_lifecycle',
    command_uuid: turn.uuid,
    state: 'started',
    session_id: turn.sessionId,
  });
  writeOutput({
    type: 'user',
    uuid: turn.uuid,
    isReplay: true,
    message: turn.message,
    session_id: turn.sessionId,
  });
  writeOutput({
    type: 'assistant',
    session_id: turn.sessionId,
    uuid: streamedAssistantUuid,
    message: { role: 'assistant', content: [{ type: 'text', text: turn.response }] },
  });

  const releasePath = process.env.CLAUDE_TEST_RELEASE_PATH;
  const settle = () => {
    appendFileSync(turn.nativePath, `${JSON.stringify({
      sessionId: turn.sessionId,
      type: 'assistant',
      uuid: streamedAssistantUuid,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
      message: { role: 'assistant', content: [{ type: 'text', text: turn.response }] },
    })}\n`);
    writeOutput({
      type: 'result',
      subtype: 'success',
      session_id: turn.sessionId,
      is_error: false,
      duration_ms: 1,
      num_turns: 1,
      result: turn.response,
    });
    writeOutput({
      type: 'command_lifecycle',
      command_uuid: turn.uuid,
      state: 'completed',
      session_id: turn.sessionId,
    });
    writeOutput({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'idle',
      session_id: turn.sessionId,
    });
  };
  if (!releasePath) {
    settle();
    return;
  }
  const poll = setInterval(() => {
    if (!existsSync(releasePath)) return;
    clearInterval(poll);
    settle();
  }, 25);
}

function scheduleHeldAbortSettlement(): void {
  if (!heldInput || heldAbortPoll) return;
  const releasePath = process.env.CLAUDE_TEST_RELEASE_PATH;
  if (!releasePath) return;
  heldAbortPoll = setInterval(() => {
    if (!heldInput || !existsSync(releasePath)) return;
    const input = heldInput;
    heldInput = null;
    if (heldAbortPoll) clearInterval(heldAbortPoll);
    heldAbortPoll = null;
    writeOutput({
      type: 'result',
      subtype: 'error_during_execution',
      terminal_reason: 'aborted_tools',
      is_error: true,
      duration_ms: 1,
      num_turns: 1,
      result: '',
      user_message_uuid: input.uuid,
      session_id: input.sessionId,
    });
    writeOutput({
      type: 'command_lifecycle',
      command_uuid: input.uuid,
      state: 'cancelled',
      session_id: input.sessionId,
    });
    writeOutput({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'idle',
      session_id: input.sessionId,
    });
  }, 5);
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
