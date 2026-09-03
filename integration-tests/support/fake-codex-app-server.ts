#!/usr/bin/env bun

import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createCodexRolloutFileName, parseCodexRolloutFileName } from './codex-rollout-filename.js';

export {};

const decoder = new TextDecoder();
const startedThreads = new Map<string, string>();
const routingControlDirectory = process.env.INTEGRATION_CODEX_ROUTING_CONTROL_DIR;
const answeredApprovalControls = new Map<number, string>();
const emittedApprovalControls = new Set<string>();
const emittedMessageControls = new Set<string>();
let processRole: 'started' | 'resumed' | null = null;
let processThreadId: string | null = null;
let processTurnId: string | null = null;
let buffered = '';

const routingControlPoll = routingControlDirectory
  ? setInterval(() => {
      publishControlledApprovals();
      publishControlledMessages();
    }, 10)
  : null;
routingControlPoll?.unref();

for await (const chunk of Bun.stdin.stream()) {
  buffered += decoder.decode(chunk, { stream: true });
  let newline = buffered.indexOf('\n');
  while (newline >= 0) {
    respond(buffered.slice(0, newline));
    buffered = buffered.slice(newline + 1);
    newline = buffered.indexOf('\n');
  }
}
if (buffered.trim()) respond(buffered);

function respond(line: string): void {
  if (!line.trim()) return;
  const request = JSON.parse(line) as {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: unknown;
  };
  if (typeof request.id !== 'number') return;
  if (!request.method && ('result' in request || 'error' in request)) {
    recordApprovalResponse(request.id, request.result, request.error);
    return;
  }
  if (request.method === 'initialize') {
    write(request.id, {
      userAgent: 'integration-fake-codex',
      codexHome: process.env.CODEX_HOME ?? '',
      platformFamily: 'unix',
      platformOs: 'linux',
    });
    return;
  }
  if (request.method === 'thread/start') {
    startThread(request.id, request.params);
    return;
  }
  if (request.method === 'thread/resume') {
    resumeThread(request.id, request.params);
    return;
  }
  if (request.method === 'thread/goal/get') {
    write(request.id, { goal: null });
    return;
  }
  if (request.method === 'thread/unsubscribe') {
    write(request.id, {});
    return;
  }
  if (request.method === 'turn/start') {
    startTurn(request.id, request.params);
    return;
  }
  if (request.method === 'turn/interrupt' && routingControlDirectory) {
    write(request.id, {});
    return;
  }
  if (request.method === 'thread/list') {
    const callLog = process.env.INTEGRATION_CODEX_CALL_LOG;
    if (callLog) appendFileSync(callLog, 'thread/list\n');
    const discoveryMode = codexDiscoveryMode();
    if (discoveryMode === 'error') {
      writeError(
        request.id,
        -32001,
        'Codex discovery failed at /home/private/.codex/sessions/rollout-secret.jsonl',
      );
      return;
    }
    if (discoveryMode === 'miss') {
      write(request.id, { data: [], nextCursor: null, backwardsCursor: null });
      return;
    }
    const threadId = process.env.INTEGRATION_CODEX_THREAD_ID;
    const nativePath = process.env.INTEGRATION_CODEX_NATIVE_PATH;
    const discovered = discoverCodexThreads();
    const explicit = threadId && nativePath ? [{ id: threadId, path: nativePath }] : [];
    write(request.id, {
      data: [
        ...explicit,
        ...discovered.filter(
          (thread) =>
            !explicit.some(
              (candidate) => candidate.id === thread.id || candidate.path === thread.path,
            ),
        ),
      ],
      nextCursor: null,
      backwardsCursor: null,
    });
    return;
  }
  if (request.method === 'thread/loaded/list') {
    write(request.id, { data: [] });
    return;
  }
  if (request.method === 'thread/turns/list') {
    write(request.id, {
      data: process.env.INTEGRATION_CODEX_HISTORY_FIXTURE === '1' ? [{
        id: 'turn-1',
        items: [],
        itemsView: 'notLoaded',
        status: 'completed',
        error: null,
        startedAt: 1_753_056_000,
        completedAt: 1_753_056_001,
        durationMs: 1_000,
      }] : [],
      nextCursor: null,
      backwardsCursor: null,
    });
    return;
  }
  if (request.method === 'thread/items/list') {
    const data = process.env.INTEGRATION_CODEX_HISTORY_FIXTURE === '1' ? [
      {
        turnId: 'turn-1',
        item: {
          type: 'userMessage',
          id: 'user-1',
          content: [{ type: 'text', text: 'paginated prompt' }],
        },
      },
      {
        turnId: 'turn-1',
        item: {
          type: 'agentMessage',
          id: 'assistant-1',
          text: 'paginated answer',
          phase: null,
          memoryCitation: null,
        },
      },
    ] : [];
    write(request.id, { data, nextCursor: null, backwardsCursor: null });
    return;
  }
  if (request.method === 'thread/fork') {
    const callLog = process.env.INTEGRATION_CODEX_CALL_LOG;
    if (callLog) appendFileSync(callLog, 'thread/fork\n');
    const paramsLog = process.env.INTEGRATION_CODEX_FORK_PARAMS_LOG;
    if (paramsLog) appendFileSync(paramsLog, `${JSON.stringify(request.params ?? {})}\n`);
    if (process.env.INTEGRATION_CODEX_FORK_JSONL === '1') {
      forkJsonlThread(request.id, request.params);
      return;
    }
    process.stdout.write(`${JSON.stringify({
      id: request.id,
      error: { code: -32601, message: 'paginated_threads is not supported yet' },
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    id: request.id,
    error: { code: -32601, message: `Unsupported integration fixture method ${request.method}` },
  })}\n`);
}

function startThread(id: number, params: Record<string, unknown> | undefined): void {
  const codexHome = process.env.CODEX_HOME;
  if (!codexHome) {
    writeError(id, -32602, 'CODEX_HOME is required');
    return;
  }

  const now = new Date();
  const threadId = randomUUID();
  const nativeDirectory = join(
    codexHome,
    'sessions',
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  );
  const nativePath = join(nativeDirectory, createCodexRolloutFileName(threadId, now));
  const timestamp = now.toISOString();
  const cwd = typeof params?.cwd === 'string' ? params.cwd : '/';
  mkdirSync(nativeDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(
    nativePath,
    `${JSON.stringify({
      timestamp,
      type: 'session_meta',
      payload: {
        id: threadId,
        timestamp,
        cwd,
        originator: 'garcon-integration',
        cli_version: '0.144.6',
        source: 'vscode',
        model_provider: 'openai',
        history_mode: params?.historyMode === 'paginated' ? 'paginated' : 'legacy',
        ...(params?.historyMode === 'paginated' ? { history_base: null } : {}),
      },
    })}\n`,
    { mode: 0o600 },
  );
  startedThreads.set(threadId, nativePath);
  processRole = 'started';
  processThreadId = threadId;
  write(id, {
    thread: { id: threadId, path: nativePath },
    model: typeof params?.model === 'string' ? params.model : 'gpt',
    modelProvider: 'openai',
    serviceTier: null,
    cwd,
  });
}

function resumeThread(id: number, params: Record<string, unknown> | undefined): void {
  const threadId = typeof params?.threadId === 'string' ? params.threadId : null;
  const nativePath = typeof params?.path === 'string' ? params.path : null;
  if (!threadId || !nativePath) {
    writeError(id, -32602, 'thread not found without a rollout path');
    return;
  }
  startedThreads.set(threadId, nativePath);
  processRole = 'resumed';
  processThreadId = threadId;
  write(id, {
    thread: { id: threadId, path: nativePath },
    model: typeof params?.model === 'string' ? params.model : 'gpt',
    modelProvider: 'openai',
    serviceTier: null,
    cwd: typeof params?.cwd === 'string' ? params.cwd : '/',
  });
}

function startTurn(id: number, params: Record<string, unknown> | undefined): void {
  const threadId = typeof params?.threadId === 'string' ? params.threadId : null;
  const nativePath = threadId ? startedThreads.get(threadId) : null;
  if (!threadId || !nativePath) {
    writeError(id, -32602, 'thread not found');
    return;
  }

  const input = Array.isArray(params?.input) ? params.input : [];
  const providerInput = input
    .filter((item): item is { type: string; text: string } => (
      Boolean(item)
      && typeof item === 'object'
      && (item as { type?: unknown }).type === 'text'
      && typeof (item as { text?: unknown }).text === 'string'
    ))
    .map((item) => item.text)
    .join('\n');
  const carriedContextEnd = providerInput.lastIndexOf('</carried-context>');
  const userContent = carriedContextEnd >= 0
    ? providerInput.slice(carriedContextEnd + '</carried-context>'.length).trim()
    : providerInput;
  const assistantContent = `codex-answer-${userContent}`;
  if (process.env.INTEGRATION_CODEX_STREAMING_TURN === '1') {
    startStreamingTurn(id, threadId, nativePath, userContent);
    return;
  }
  const timestamp = new Date().toISOString();
  appendFileSync(
    nativePath,
    [
      JSON.stringify({
        timestamp,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: userContent }],
        },
      }),
      JSON.stringify({
        timestamp,
        type: 'event_msg',
        payload: { type: 'user_message', message: userContent },
      }),
      JSON.stringify({
        timestamp,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: assistantContent }],
        },
      }),
      '',
    ].join('\n'),
  );

  const turnId = randomUUID();
  processTurnId = turnId;
  write(id, {
    turn: codexTurn(turnId, 'inProgress', timestamp),
  });
  notify('turn/started', {
    threadId,
    turn: codexTurn(turnId, 'inProgress', timestamp),
  });
  notify('turn/completed', {
    threadId,
    turn: codexTurn(turnId, 'completed', timestamp),
  });
}

// Mirrors how Codex runs a turn: items reach the event stream before the rollout records them,
// and the rollout also records entries (reasoning) that the event stream renders differently.
// The turn stays in progress until the release file appears so tests can observe that window.
function streamedLiveAnswers(userContent: string): readonly string[] {
  return [`codex-live-${userContent}`, `codex-live2-${userContent}`];
}

function startStreamingTurn(
  id: number,
  threadId: string,
  nativePath: string,
  userContent: string,
): void {
  const timestamp = new Date().toISOString();
  const turnId = randomUUID();
  processTurnId = turnId;
  const metadata = { turn_id: turnId };
  const reasoningItemId = `${turnId}-reasoning`;
  appendFileSync(
    nativePath,
    [
      JSON.stringify({
        timestamp,
        type: 'response_item',
        payload: {
          type: 'message',
          id: `${turnId}-user`,
          role: 'user',
          content: [{ type: 'input_text', text: userContent }],
          internal_chat_message_metadata_passthrough: metadata,
        },
      }),
      JSON.stringify({
        timestamp,
        type: 'event_msg',
        payload: { type: 'user_message', message: userContent },
      }),
      JSON.stringify({
        timestamp,
        type: 'response_item',
        payload: {
          type: 'reasoning',
          id: reasoningItemId,
          summary: [{ type: 'summary_text', text: `codex-reasoning-${userContent}` }],
          internal_chat_message_metadata_passthrough: metadata,
        },
      }),
      '',
    ].join('\n'),
  );

  write(id, { turn: codexTurn(turnId, 'inProgress', timestamp) });
  notify('turn/started', { threadId, turn: codexTurn(turnId, 'inProgress', timestamp) });
  notify('item/completed', {
    threadId,
    turnId,
    item: {
      type: 'reasoning',
      id: reasoningItemId,
      summary: [`codex-reasoning-${userContent}`],
      content: [],
    },
  });
  streamedLiveAnswers(userContent).forEach((text, index) => {
    notify('item/completed', {
      threadId,
      turnId,
      item: {
        type: 'agentMessage',
        id: `${turnId}-live-${index}`,
        text,
        phase: null,
        memoryCitation: null,
      },
    });
  });

  awaitTurnRelease(() => {
    const completedAt = new Date().toISOString();
    appendFileSync(
      nativePath,
      `${streamedLiveAnswers(userContent).map((text, index) => JSON.stringify({
        timestamp: completedAt,
        type: 'response_item',
        payload: {
          type: 'message',
          id: `${turnId}-live-${index}`,
          role: 'assistant',
          content: [{ type: 'output_text', text }],
          internal_chat_message_metadata_passthrough: metadata,
        },
      })).join('\n')}\n`,
    );
    notify('turn/completed', { threadId, turn: codexTurn(turnId, 'completed', completedAt) });
  });
}

function awaitTurnRelease(finish: () => void): void {
  const releasePath = process.env.INTEGRATION_CODEX_TURN_RELEASE;
  if (!releasePath) {
    finish();
    return;
  }
  const poll = setInterval(() => {
    if (!existsSync(releasePath)) return;
    clearInterval(poll);
    finish();
  }, 1_000);
}

function forkJsonlThread(id: number, params: Record<string, unknown> | undefined): void {
  const threadId = typeof params?.threadId === 'string' ? params.threadId : null;
  const sourcePath = typeof params?.path === 'string' ? params.path : null;
  if (!threadId || !sourcePath) {
    process.stdout.write(`${JSON.stringify({
      id,
      error: {
        code: -32600,
        message: `no rollout found for thread id ${threadId ?? 'unknown'}`,
      },
    })}\n`);
    return;
  }

  try {
    const targetThreadId = randomUUID();
    const targetPath = join(
      dirname(sourcePath),
      createCodexRolloutFileName(targetThreadId, new Date()),
    );
    const lines = readFileSync(sourcePath, 'utf8').split('\n');
    const metadataIndex = lines.findIndex((entry) => entry.trim());
    const metadata = JSON.parse(lines[metadataIndex]!) as {
      type?: unknown;
      payload?: Record<string, unknown>;
    };
    if (metadata.type !== 'session_meta' || !metadata.payload) {
      throw new Error('source transcript has no session metadata');
    }
    lines[metadataIndex] = JSON.stringify({
      ...metadata,
      payload: { ...metadata.payload, id: targetThreadId },
    });
    writeFileSync(targetPath, lines.join('\n'));
    write(id, {
      thread: { id: targetThreadId, path: targetPath },
      model: typeof params?.model === 'string' ? params.model : 'gpt',
      modelProvider: 'openai',
      serviceTier: null,
      cwd: typeof params?.cwd === 'string' ? params.cwd : '/',
    });
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      id,
      error: {
        code: -32602,
        message: error instanceof Error ? error.message : String(error),
      },
    })}\n`);
  }
}

function write(id: number, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function writeError(id: number, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ id, error: { code, message } })}\n`);
}

function notify(method: string, params: unknown): void {
  process.stdout.write(`${JSON.stringify({ method, params })}\n`);
}

function codexTurn(
  id: string,
  status: 'inProgress' | 'completed',
  timestamp: string,
): Record<string, unknown> {
  const startedAt = Date.parse(timestamp);
  return {
    id,
    items: [],
    itemsView: 'full',
    status,
    error: null,
    startedAt,
    completedAt: status === 'completed' ? startedAt : null,
    durationMs: status === 'completed' ? 0 : null,
  };
}

function codexDiscoveryMode(): 'normal' | 'miss' | 'error' {
  if (process.env.INTEGRATION_CODEX_DISCOVERY_CONTROL !== '1') return 'normal';
  const codexHome = process.env.CODEX_HOME;
  if (!codexHome) return 'normal';
  try {
    const mode = readFileSync(join(codexHome, 'integration-discovery-mode'), 'utf8').trim();
    return mode === 'miss' || mode === 'error' ? mode : 'normal';
  } catch {
    return 'normal';
  }
}

function discoverCodexThreads(): Array<{ id: string; path: string }> {
  const codexHome = process.env.CODEX_HOME;
  if (!codexHome) return [];
  const files: Array<{ id: string; path: string }> = [];
  collectRolloutFiles(join(codexHome, 'sessions'), files);
  return files.flatMap((candidate) => {
    try {
      const firstLine = readFileSync(candidate.path, 'utf8')
        .split('\n')
        .find((line) => line.trim());
      const entry = firstLine
        ? (JSON.parse(firstLine) as {
        type?: unknown;
        payload?: { id?: unknown };
          })
        : null;
      return entry?.type === 'session_meta' && entry.payload?.id === candidate.id
        ? [candidate]
        : [];
    } catch {
      return [];
    }
  });
}

function collectRolloutFiles(directory: string, files: Array<{ id: string; path: string }>): void {
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        collectRolloutFiles(filePath, files);
        continue;
      }
      if (!entry.isFile()) continue;
      const parsed = parseCodexRolloutFileName(entry.name);
      if (parsed) files.push({ id: parsed.threadId, path: filePath });
    }
  } catch {
    return;
  }
}

function publishControlledApprovals(): void {
  if (!routingControlDirectory || !processRole || !processThreadId || !processTurnId) return;
  let entries: string[];
  try {
    entries = readdirSync(routingControlDirectory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.request.json') || emittedApprovalControls.has(entry)) continue;
    try {
      const control = JSON.parse(readFileSync(join(routingControlDirectory, entry), 'utf8')) as {
        target?: unknown;
        targetThreadId?: unknown;
        requestId?: unknown;
        command?: unknown;
        method?: unknown;
      };
      if (control.target !== processRole) continue;
      if (control.targetThreadId !== undefined && control.targetThreadId !== processThreadId) continue;
      if (typeof control.requestId !== 'number' || !Number.isSafeInteger(control.requestId)) continue;
      if (typeof control.command !== 'string' || !control.command) continue;
      if (control.method !== undefined && (typeof control.method !== 'string' || !control.method)) continue;
      emittedApprovalControls.add(entry);
      answeredApprovalControls.set(control.requestId, entry);
      notifyServerRequest(
        control.requestId,
        typeof control.method === 'string'
          ? control.method
          : 'item/commandExecution/requestApproval',
        {
          threadId: processThreadId,
          turnId: processTurnId,
          itemId: entry.slice(0, -'.request.json'.length),
          command: control.command,
        },
      );
      writeFileSync(join(routingControlDirectory, `${entry}.sent`), '');
    } catch {
      continue;
    }
  }
}

function publishControlledMessages(): void {
  if (!routingControlDirectory || !processRole || !processThreadId || !processTurnId) return;
  let entries: string[];
  try {
    entries = readdirSync(routingControlDirectory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.message.json') || emittedMessageControls.has(entry)) continue;
    try {
      const control = JSON.parse(readFileSync(join(routingControlDirectory, entry), 'utf8')) as {
        target?: unknown;
        targetThreadId?: unknown;
        content?: unknown;
      };
      if (control.target !== processRole) continue;
      if (control.targetThreadId !== undefined && control.targetThreadId !== processThreadId) continue;
      if (typeof control.content !== 'string' || !control.content) continue;
      emittedMessageControls.add(entry);
      notify('item/completed', {
        threadId: processThreadId,
        turnId: processTurnId,
        item: {
          type: 'agentMessage',
          id: entry.slice(0, -'.message.json'.length),
          text: control.content,
          phase: null,
          memoryCitation: null,
        },
      });
      writeFileSync(join(routingControlDirectory, `${entry}.sent`), '');
    } catch {
      continue;
    }
  }
}

function notifyServerRequest(id: number, method: string, params: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ id, method, params })}\n`);
}

function recordApprovalResponse(id: number, result: unknown, error: unknown): void {
  const control = answeredApprovalControls.get(id);
  if (!routingControlDirectory || !control) return;
  answeredApprovalControls.delete(id);
  writeFileSync(
    join(routingControlDirectory, `${control}.response.json`),
    JSON.stringify({ result: result ?? null, error: error ?? null }),
  );
}
