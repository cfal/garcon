// OpenAI Codex SDK integration. Extends AbsProvider so all output
// flows through typed events wired in the composition root.

import { Codex } from '@openai/codex-sdk';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { normalizeToolResultContent } from '../chats/normalize.js';
import { AssistantMessage, ThinkingMessage, BashToolUseMessage, EditToolUseMessage, WebSearchToolUseMessage, TodoWriteToolUseMessage, ToolResultMessage, ErrorMessage } from '../../common/chat-types.js';
import { AbsProvider } from './base.js';

const CODEX_ITEM_NORMALIZERS = {
  agent_message: (item) => ({
    type: 'item', itemType: 'agent_message',
    message: { role: 'assistant', content: item.text },
  }),
  reasoning: (item) => ({
    type: 'item', itemType: 'reasoning',
    message: { role: 'assistant', content: item.text, isReasoning: true },
  }),
  command_execution: (item) => ({
    type: 'item', itemType: 'command_execution',
    command: item.command, output: item.aggregated_output,
    exitCode: item.exit_code, status: item.status,
  }),
  file_change: (item) => ({
    type: 'item', itemType: 'file_change',
    changes: item.changes, status: item.status,
  }),
  web_search: (item) => ({
    type: 'item', itemType: 'web_search', query: item.query,
  }),
  todo_list: (item) => ({
    type: 'item', itemType: 'todo_list', items: item.items,
  }),
  error: (item) => ({
    type: 'item', itemType: 'error',
    message: { role: 'error', content: item.message },
  }),
};

function normalizeCodexItem(item) {
  const fn = CODEX_ITEM_NORMALIZERS[item.type];
  return fn ? fn(item) : { type: 'item', itemType: item.type, item };
}

function normalizeCodexStreamEvent(event) {
  if (event.type === 'turn.started')   return { type: 'turn_started' };
  if (event.type === 'turn.completed') return { type: 'turn_complete', usage: event.usage };
  if (event.type === 'turn.failed')    return { type: 'turn_failed', error: event.error };
  if (event.type === 'thread.started') return { type: 'thread_started', threadId: event.thread_id };
  if (event.type === 'error')          return { type: 'error', message: event.message };

  if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
    return event.item ? normalizeCodexItem(event.item) : { type: event.type, item: null };
  }

  return { type: event.type, data: event };
}

export function convertCodexEventToChatMessages(transformed) {
  if (!transformed) return [];

  const chatMessages = [];
  const now = new Date().toISOString();

  if (transformed.type === 'item') {
    switch (transformed.itemType) {
      case 'agent_message':
        if (transformed.message?.content?.trim()) {
          chatMessages.push(new AssistantMessage(now, transformed.message.content));
        }
        break;
      case 'reasoning':
        if (transformed.message?.content?.trim()) {
          chatMessages.push(new ThinkingMessage(now, transformed.message.content));
        }
        break;
      case 'command_execution':
        if (transformed.command) {
          const toolId = `codex-cmd-${Date.now()}`;
          chatMessages.push(new BashToolUseMessage(now, toolId, 'Bash', transformed.command));
          if (transformed.output !== undefined) {
            chatMessages.push(new ToolResultMessage(now, toolId, normalizeToolResultContent(transformed.output), transformed.exitCode !== 0));
          }
        }
        break;
      case 'file_change': {
        const editId = `codex-edit-${Date.now()}`;
        const changes = Array.isArray(transformed.changes)
          ? transformed.changes
          : (transformed.changes && typeof transformed.changes === 'object')
            ? [transformed.changes]
            : [];
        if (changes.length > 0) {
          chatMessages.push(new EditToolUseMessage(now, editId, 'Edit', undefined, undefined, undefined, changes));
          if (transformed.status === 'completed') {
            chatMessages.push(new ToolResultMessage(now, editId, normalizeToolResultContent('File changes applied'), false));
          }
        }
        break;
      }
      case 'web_search': {
        const searchId = `codex-search-${Date.now()}`;
        chatMessages.push(new WebSearchToolUseMessage(now, searchId, 'WebSearch', transformed.query || ''));
        if (transformed.query) {
          chatMessages.push(new ToolResultMessage(now, searchId, normalizeToolResultContent(`Searched: ${transformed.query}`), false));
        }
        break;
      }
      case 'todo_list': {
        const todoId = `codex-todo-${Date.now()}`;
        chatMessages.push(new TodoWriteToolUseMessage(now, todoId, 'TodoWrite', transformed.items || []));
        chatMessages.push(new ToolResultMessage(now, todoId, normalizeToolResultContent(transformed.items), false));
        break;
      }
      case 'error':
        if (transformed.message?.content) {
          chatMessages.push(new ErrorMessage(now, transformed.message.content));
        }
        break;
    }
  }

  return chatMessages;
}

function mapThinkingModeToReasoningEffort(thinkingMode) {
  switch (thinkingMode) {
    case 'think': return 'low';
    case 'think-hard': return 'medium';
    case 'think-harder': return 'high';
    case 'ultrathink': return 'xhigh';
    default: return undefined;
  }
}

const CODEX_SANDBOX = {
  default:           { sandboxMode: 'workspace-write',    approvalPolicy: 'never' },
  acceptEdits:       { sandboxMode: 'workspace-write',    approvalPolicy: 'never' },
  bypassPermissions: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' },
};

function codexSandboxOptions(permissionMode) {
  return CODEX_SANDBOX[permissionMode] ?? CODEX_SANDBOX.default;
}

async function runCodexExec(args, input) {
  const proc = Bun.spawn(['codex', ...args], {
    stdin: new Blob([input]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout.text(),
    proc.stderr.text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    const details = (stderr || stdout || '').trim();
    throw new Error(`Codex exec failed with code ${exitCode}: ${details}`);
  }
  return { stdout, stderr };
}

export async function runSingleQuery(prompt, options = {}) {
  const {
    cwd,
    projectPath,
    model,
    permissionMode = 'default',
    thinkingMode,
    modelReasoningEffort,
  } = options;

  const workingDirectory = cwd || projectPath || process.cwd();
  const effectivePermissionMode = permissionMode === 'plan' ? 'default' : permissionMode;
  const { sandboxMode, approvalPolicy } = codexSandboxOptions(effectivePermissionMode);
  const reasoningEffort = modelReasoningEffort || mapThinkingModeToReasoningEffort(thinkingMode);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-single-query-'));
  const outputPath = path.join(tmpDir, 'last-message.txt');
  const args = [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox',
    sandboxMode,
    '--cd',
    workingDirectory,
    '--output-last-message',
    outputPath,
  ];

  if (model) {
    args.push('--model', model);
  }
  if (reasoningEffort) {
    args.push('--config', `model_reasoning_effort="${reasoningEffort}"`);
  }
  if (approvalPolicy) {
    args.push('--config', `approval_policy="${approvalPolicy}"`);
  }
  args.push('-');

  try {
    const { stdout } = await runCodexExec(args, prompt);
    let text = '';
    try {
      text = await fs.readFile(outputPath, 'utf8');
    } catch {
      text = stdout;
    }
    return text.trim();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function runCodexStreamedTurn({
  thread,
  command,
  abortController,
  getSessionId,
  isAborted,
  onThreadStarted,
  onEvent,
}) {
  const streamedTurn = await thread.runStreamed(command, {
    signal: abortController.signal
  });

  for await (const event of streamedTurn.events) {
    if (event.type === 'thread.started' && event.thread_id) {
      const currentId = getSessionId();
      if (!currentId) onThreadStarted(event.thread_id);
    }

    const providerSessionId = getSessionId();
    if (providerSessionId && isAborted(providerSessionId)) {
      break;
    }

    if (event.type === 'item.started' || event.type === 'item.updated') {
      continue;
    }

    const transformed = normalizeCodexStreamEvent(event);
    onEvent(transformed);
  }
}

export class CodexProvider extends AbsProvider {
  #sessions = new Map();

  constructor() {
    super();
  }

  async startSession({
    command,
    chatId,
    images,
    model,
    permissionMode,
    projectPath,
    thinkingMode,
    modelReasoningEffort,
  } = {}) {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const onThreadStarted = (providerSessionId) => {
        if (settled) return;
        settled = true;
        resolve(providerSessionId);
      };

      this.runTurn({
        command,
        chatId,
        images,
        model,
        permissionMode,
        projectPath,
        thinkingMode,
        modelReasoningEffort,
        onThreadStarted,
      }).catch((error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
  }

  async runTurn({
    command,
    providerSessionId,
    chatId,
    onThreadStarted,
    projectPath,
    model,
    permissionMode = 'default',
    thinkingMode,
    modelReasoningEffort,
  } = {}) {
    const workingDirectory = projectPath || process.cwd();
    const effectivePermissionMode = permissionMode === 'plan' ? 'default' : permissionMode;
    const { sandboxMode, approvalPolicy } = codexSandboxOptions(effectivePermissionMode);

    let codex;
    let thread;
    let currentProviderSessionId = providerSessionId;
    const abortController = new AbortController();

    let chatCreatedEmitted = false;

    try {
      codex = new Codex();

      const threadOptions = {
        workingDirectory,
        skipGitRepoCheck: true,
        sandboxMode,
        approvalPolicy,
        model,
        modelReasoningEffort: modelReasoningEffort || mapThinkingModeToReasoningEffort(thinkingMode),
      };

      if (providerSessionId) {
        thread = codex.resumeThread(providerSessionId, threadOptions);
      } else {
        thread = codex.startThread(threadOptions);
      }

      currentProviderSessionId = providerSessionId || thread.id || null;
      if (currentProviderSessionId) {
        this.#sessions.set(currentProviderSessionId, {
          thread,
          codex,
          status: 'running',
          abortController,
          startedAt: new Date().toISOString()
        });
        this.emitProcessing(chatId, true);

        if (!chatCreatedEmitted) {
          this.emitSessionCreated(chatId);
          chatCreatedEmitted = true;
        }
        if (typeof onThreadStarted === 'function') onThreadStarted(currentProviderSessionId);
      }

      await runCodexStreamedTurn({
        thread,
        command,
        abortController,
        getSessionId: () => currentProviderSessionId,
        isAborted: (id) => {
          const session = this.#sessions.get(id);
          return Boolean(session && session.status === 'aborted');
        },
        onThreadStarted: (threadId) => {
          currentProviderSessionId = threadId;
          this.#sessions.set(currentProviderSessionId, {
            thread,
            codex,
            status: 'running',
            abortController,
            startedAt: new Date().toISOString()
          });
          this.emitProcessing(chatId, true);
          if (!chatCreatedEmitted) {
            this.emitSessionCreated(chatId);
            chatCreatedEmitted = true;
          }
          if (typeof onThreadStarted === 'function') onThreadStarted(currentProviderSessionId);
        },
        onEvent: (transformed) => {
          const chatMessages = convertCodexEventToChatMessages(transformed);
          if (chatMessages.length > 0) {
            this.emitMessages(chatId, chatMessages);
          }
        },
      });

      this.emitFinished(chatId);

    } catch (error) {
      const session = currentProviderSessionId ? this.#sessions.get(currentProviderSessionId) : null;
      const wasAborted =
        session?.status === 'aborted' ||
        error?.name === 'AbortError' ||
        String(error?.message || '').toLowerCase().includes('aborted');

      if (!wasAborted) {
        console.error('codex: error:', error);
        this.emitFailed(chatId, error.message);
      }

    } finally {
      if (currentProviderSessionId) {
        const session = this.#sessions.get(currentProviderSessionId);
        if (session) {
          session.status = session.status === 'aborted' ? 'aborted' : 'completed';
          this.emitProcessing(chatId, false);
        }
      }
    }
  }

  abort(providerSessionId) {
    const session = this.#sessions.get(providerSessionId);

    if (!session) {
      return false;
    }

    session.status = 'aborted';
    try {
      session.abortController?.abort();
    } catch (error) {
      console.warn(`codex: failed to abort session ${providerSessionId}:`, error);
    }

    return true;
  }

  isRunning(providerSessionId) {
    const session = this.#sessions.get(providerSessionId);
    return session?.status === 'running';
  }

  getRunningSessions() {
    return Array.from(this.#sessions.entries())
      .filter(([, session]) => session.status === 'running')
      .map(([id, session]) => ({ id, status: session.status, startedAt: session.startedAt }));
  }

  startPurgeTimer() {
    return setInterval(() => {
      const now = Date.now();
      const maxAge = 30 * 60 * 1000;

      for (const [id, session] of this.#sessions.entries()) {
        if (session.status !== 'running') {
          const startedAt = new Date(session.startedAt).getTime();
          if (now - startedAt > maxAge) {
            this.#sessions.delete(id);
          }
        }
      }
    }, 5 * 60 * 1000);
  }
}
