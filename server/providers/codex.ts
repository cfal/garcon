// OpenAI Codex SDK integration. Extends AbsProvider so all output
// flows through typed events wired in the composition root.

import { Codex } from '@openai/codex-sdk';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { normalizeToolResultContent, normalizeTodoItems } from './normalize-util.js';
import { AssistantMessage, ThinkingMessage, BashToolUseMessage, EditToolUseMessage, WebSearchToolUseMessage, TodoWriteToolUseMessage, ToolResultMessage, ErrorMessage } from '../../common/chat-types.js';
import { AbsProvider } from './base.js';
import type { PermissionMode, ThinkingMode } from '../../common/chat-modes.js';
import type { StartSessionRequest, ResumeTurnRequest, AgentCommandImage, StartedProviderSession } from './types.js';

interface CodexItem {
  type: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  status?: string;
  changes?: unknown;
  items?: unknown[];
  message?: string;
  query?: string;
}

interface CodexStreamEvent {
  type: string;
  item?: CodexItem;
  thread_id?: string;
  usage?: unknown;
  error?: unknown;
  message?: string;
}

interface NormalizedEvent {
  type: string;
  itemType?: string;
  message?: { role: string; content: string; isReasoning?: boolean };
  command?: string;
  output?: string;
  exitCode?: number;
  status?: string;
  changes?: unknown;
  items?: unknown[];
  query?: string;
  threadId?: string;
  usage?: unknown;
  error?: unknown;
  data?: unknown;
  item?: unknown;
}

const CODEX_ITEM_NORMALIZERS: Record<string, (item: CodexItem) => NormalizedEvent> = {
  agent_message: (item) => ({
    type: 'item', itemType: 'agent_message',
    message: { role: 'assistant', content: item.text || '' },
  }),
  reasoning: (item) => ({
    type: 'item', itemType: 'reasoning',
    message: { role: 'assistant', content: item.text || '', isReasoning: true },
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
    message: { role: 'error', content: item.message || '' },
  }),
};

function normalizeCodexItem(item: CodexItem): NormalizedEvent {
  const fn = CODEX_ITEM_NORMALIZERS[item.type];
  return fn ? fn(item) : { type: 'item', itemType: item.type, item };
}

function normalizeCodexStreamEvent(event: CodexStreamEvent): NormalizedEvent {
  if (event.type === 'turn.started') return { type: 'turn_started' };
  if (event.type === 'turn.completed') return { type: 'turn_complete', usage: event.usage };
  if (event.type === 'turn.failed') return { type: 'turn_failed', error: event.error };
  if (event.type === 'thread.started') return { type: 'thread_started', threadId: event.thread_id };
  if (event.type === 'error') return { type: 'error', message: { role: 'error', content: event.message || '' } };

  if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
    return event.item ? normalizeCodexItem(event.item) : { type: event.type, item: null };
  }

  return { type: event.type, data: event };
}

export function convertCodexEventToChatMessages(transformed: NormalizedEvent): unknown[] {
  if (!transformed) return [];

  const chatMessages: unknown[] = [];
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
        chatMessages.push(new TodoWriteToolUseMessage(now, todoId, 'TodoWrite', normalizeTodoItems(transformed.items)));
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

function mapThinkingModeToCodexEffort(thinkingMode: ThinkingMode | undefined): string | undefined {
  switch (thinkingMode) {
    case 'think': return 'low';
    case 'think-hard': return 'medium';
    case 'think-harder': return 'high';
    case 'ultrathink': return 'xhigh';
    default: return undefined;
  }
}

const CODEX_SANDBOX: Record<string, { sandboxMode: string; approvalPolicy: string }> = {
  default: { sandboxMode: 'workspace-write', approvalPolicy: 'never' },
  acceptEdits: { sandboxMode: 'workspace-write', approvalPolicy: 'never' },
  bypassPermissions: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' },
};
export const CODEX_SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

function codexSandboxOptions(permissionMode: PermissionMode): { sandboxMode: string; approvalPolicy: string } {
  return CODEX_SANDBOX[permissionMode] ?? CODEX_SANDBOX.default;
}

export async function findCodexSessionFileBySessionId(
  sessionId: string | null | undefined,
  {
    waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  }: {
    waitTimeoutMs?: number;
    pollIntervalMs?: number;
  } = {},
): Promise<string | null> {
  if (!sessionId) {
    return null;
  }

  const suffix = `${sessionId}.jsonl`;
  const initialMatch = await findFileWithSuffix(CODEX_SESSIONS_ROOT, suffix);
  if (initialMatch) {
    return initialMatch;
  }

  const normalizedWaitTimeoutMs = Math.max(0, waitTimeoutMs);
  if (normalizedWaitTimeoutMs === 0) {
    return null;
  }

  const normalizedPollIntervalMs = Math.max(1, pollIntervalMs);
  const startedAt = Date.now();
  console.info(`codex: waiting up to ${normalizedWaitTimeoutMs}ms for rollout file for session ${sessionId}`);

  while (Date.now() - startedAt < normalizedWaitTimeoutMs) {
    await sleep(Math.min(normalizedPollIntervalMs, normalizedWaitTimeoutMs));
    const match = await findFileWithSuffix(CODEX_SESSIONS_ROOT, suffix);
    if (match) {
      console.info(`codex: resolved rollout file for session ${sessionId} after ${Date.now() - startedAt}ms: ${match}`);
      return match;
    }
  }

  console.warn(`codex: rollout file not found for session ${sessionId} after ${normalizedWaitTimeoutMs}ms`);
  return null;
}

// Translates raw Codex SDK/CLI errors into actionable user-facing messages.
export function humanizeCodexError(error: any): string {
  const raw = String(error?.message || error || '');

  if (/not found|ENOENT.*codex|spawn codex/i.test(raw)) {
    return 'Codex CLI is not installed or not in PATH. Install it with: npm i -g @openai/codex';
  }
  if (/authentication|unauthorized|401|api.?key/i.test(raw)) {
    return 'Codex authentication failed. Run "codex" in your terminal to sign in.';
  }
  if (/rate.?limit|429/i.test(raw)) {
    return 'Codex rate limit exceeded. Please wait a moment and try again.';
  }
  if (/model.*not.?found|invalid.*model|does not exist/i.test(raw)) {
    return `Codex model not available. Check your model selection or Codex configuration.`;
  }
  if (/ECONNREFUSED|ENOTFOUND|network|timeout|ETIMEDOUT/i.test(raw)) {
    return 'Codex could not connect to the API. Check your network connection.';
  }
  if (/exited with (code|signal)/i.test(raw)) {
    // Strip internal stack trace paths, keep the meaningful part.
    const cleaned = raw.replace(/\s+at\s+\S+.*$/gm, '').trim();
    return `Codex process failed: ${cleaned}`;
  }

  return `Codex error: ${raw}`;
}

// Mime type to file extension mapping for image temp files.
const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// Decodes base64 data-URL images to temp files for the Codex SDK,
// which only accepts local file paths via { type: "local_image" }.
async function writeImagesToTempFiles(images: AgentCommandImage[]): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-images-'));
  const paths: string[] = [];

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const match = img.data?.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) continue;

    const mimeType = match[1];
    const base64Data = match[2];
    const ext = MIME_EXTENSIONS[mimeType] || '.png';
    const filePath = path.join(tmpDir, `image-${i}${ext}`);

    await fs.writeFile(filePath, Buffer.from(base64Data, 'base64'));
    paths.push(filePath);
  }

  const cleanup = async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
  };

  return { paths, cleanup };
}

// Builds the Codex SDK Input type from a command string and optional images.
function buildCodexInput(command: string, imagePaths?: string[]): string | Array<{ type: string; text?: string; path?: string }> {
  if (!imagePaths?.length) return command;
  return [
    { type: 'text', text: command },
    ...imagePaths.map((p) => ({ type: 'local_image', path: p })),
  ];
}

async function runCodexExec(args: string[], input: string): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn(['codex', ...args], {
    stdin: new Blob([input]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    const details = (stderr || stdout || '').trim();
    throw new Error(`Codex exec failed with code ${exitCode}: ${details}`);
  }
  return { stdout, stderr };
}

export async function runSingleQuery(prompt: string, options: Record<string, any> = {}): Promise<string> {
  const {
    cwd,
    projectPath,
    model,
    permissionMode = 'default',
    thinkingMode,
  } = options;

  const workingDirectory = cwd || projectPath || process.cwd();
  const effectivePermissionMode = permissionMode === 'plan' ? 'default' : permissionMode;
  const { sandboxMode, approvalPolicy } = codexSandboxOptions(effectivePermissionMode);
  const reasoningEffort = mapThinkingModeToCodexEffort(thinkingMode);

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

interface CodexSession {
  thread: any;
  codex: any;
  status: 'running' | 'completed' | 'aborted';
  abortController: AbortController;
  startedAt: string;
}

interface CodexRunTurnRequest extends Omit<ResumeTurnRequest, 'providerSessionId'> {
  providerSessionId?: string;
}

interface StartedSessionTracker {
  resolved: boolean;
  promise: Promise<StartedProviderSession>;
  reject: (error: unknown) => void;
  resolve: (session: StartedProviderSession) => void;
}

interface CodexTurnExecution {
  chatId: string;
  codex: any;
  thread: any;
  input: string | Array<{ type: string; text?: string; path?: string }>;
  abortController: AbortController;
  providerSessionId: string | null;
  imageCleanup?: (() => Promise<void>) | undefined;
  emitSessionCreated: boolean;
  sessionCreatedEmitted: boolean;
  startedSession: StartedSessionTracker | null;
}

function createStartedSessionTracker(): StartedSessionTracker {
  let resolveRef: ((session: StartedProviderSession) => void) | null = null;
  let rejectRef: ((error: unknown) => void) | null = null;
  const promise = new Promise<StartedProviderSession>((resolve, reject) => {
    resolveRef = resolve;
    rejectRef = reject;
  });
  return {
    resolved: false,
    promise,
    resolve: (session) => {
      if (resolveRef) resolveRef(session);
    },
    reject: (error) => {
      if (rejectRef) rejectRef(error);
    },
  };
}

async function findFileWithSuffix(dir: string, suffix: string): Promise<string | null> {
  if (!dir || !suffix) {
    return null;
  }

  if (typeof Bun !== 'undefined' && typeof Bun.Glob === 'function') {
    try {
      const escapedSuffix = suffix
        .replace(/\\/g, '\\\\')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/\*/g, '\\*')
        .replace(/\?/g, '\\?');
      const glob = new Bun.Glob(`**/*${escapedSuffix}`);
      for await (const filePath of glob.scan({
        cwd: dir,
        absolute: true,
        onlyFiles: true,
        followSymlinks: false,
      })) {
        return filePath;
      }
      return null;
    } catch {
      return null;
    }
  }

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const found = await findFileWithSuffix(fullPath, suffix);
      if (found) return found;
    } else if (entry.name.endsWith(suffix)) {
      return fullPath;
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CodexProvider extends AbsProvider {
  #sessions = new Map<string, CodexSession>();

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
  }: StartSessionRequest): Promise<StartedProviderSession> {
    const execution = await this.#createTurnExecution({
      command,
      chatId,
      images,
      model,
      permissionMode,
      projectPath,
      thinkingMode,
      providerSessionId: null,
      emitSessionCreated: true,
      captureStartedSession: true,
    });
    void this.#runExecution(execution);
    return execution.startedSession!.promise;
  }

  async runTurn({
    command,
    providerSessionId,
    chatId,
    images,
    projectPath,
    model,
    permissionMode = 'default',
    thinkingMode,
  }: CodexRunTurnRequest): Promise<void> {
    const execution = await this.#createTurnExecution({
      command,
      chatId,
      images,
      model,
      permissionMode,
      projectPath,
      thinkingMode,
      providerSessionId: providerSessionId || null,
      emitSessionCreated: false,
      captureStartedSession: false,
    });
    await this.#runExecution(execution);
  }

  async #createTurnExecution({
    command,
    chatId,
    images,
    model,
    permissionMode = 'default',
    projectPath,
    thinkingMode,
    providerSessionId,
    emitSessionCreated,
    captureStartedSession,
  }: CodexRunTurnRequest & {
    emitSessionCreated: boolean;
    captureStartedSession: boolean;
  }): Promise<CodexTurnExecution> {
    const workingDirectory = projectPath;
    const effectivePermissionMode = permissionMode === 'plan' ? 'default' : permissionMode;
    const { sandboxMode, approvalPolicy } = codexSandboxOptions(effectivePermissionMode);
    const abortController = new AbortController();

    let imageCleanup: (() => Promise<void>) | undefined;

    try {
      let imagePaths: string[] | undefined;
      if (images?.length) {
        const result = await writeImagesToTempFiles(images);
        imagePaths = result.paths;
        imageCleanup = result.cleanup;
      }

      const input = buildCodexInput(command, imagePaths);
      const codex = new Codex();
      const threadOptions: Record<string, unknown> = {
        workingDirectory,
        skipGitRepoCheck: true,
        sandboxMode,
        approvalPolicy,
        model,
        modelReasoningEffort: mapThinkingModeToCodexEffort(thinkingMode),
      };
      const thread = providerSessionId
        ? codex.resumeThread(providerSessionId, threadOptions)
        : codex.startThread(threadOptions);

      return {
        chatId,
        codex,
        thread,
        input,
        abortController,
        providerSessionId: providerSessionId || thread.id || null,
        imageCleanup,
        emitSessionCreated,
        sessionCreatedEmitted: false,
        startedSession: captureStartedSession ? createStartedSessionTracker() : null,
      };
    } catch (error) {
      if (imageCleanup) await imageCleanup();
      throw error;
    }
  }

  async #runExecution(execution: CodexTurnExecution): Promise<void> {
    try {
      await this.#activateSession(execution, execution.providerSessionId);
      await this.#streamExecution(execution);
      this.emitFinished(execution.chatId);
    } catch (error: any) {
      const session = execution.providerSessionId
        ? this.#sessions.get(execution.providerSessionId)
        : null;
      const wasAborted =
        session?.status === 'aborted' ||
        error?.name === 'AbortError' ||
        String(error?.message || '').toLowerCase().includes('aborted');

      if (execution.startedSession && !execution.startedSession.resolved) {
        execution.startedSession.resolved = true;
        execution.startedSession.reject(error);
      }

      if (!wasAborted) {
        console.error('codex: error:', error);
        this.emitFailed(execution.chatId, humanizeCodexError(error));
      }
    } finally {
      if (execution.imageCleanup) await execution.imageCleanup();
      if (execution.providerSessionId) {
        const session = this.#sessions.get(execution.providerSessionId);
        if (session) {
          session.status = session.status === 'aborted' ? 'aborted' : 'completed';
          this.emitProcessing(execution.chatId, false);
        }
      }
    }
  }

  async #streamExecution(execution: CodexTurnExecution): Promise<void> {
    const streamedTurn = await execution.thread.runStreamed(execution.input, {
      signal: execution.abortController.signal,
    });

    for await (const event of streamedTurn.events) {
      if (event.type === 'thread.started' && event.thread_id) {
        await this.#activateSession(execution, event.thread_id);
      }

      if (execution.providerSessionId && this.#isAborted(execution.providerSessionId)) {
        break;
      }

      if (event.type === 'item.started' || event.type === 'item.updated') {
        continue;
      }

      const transformed = normalizeCodexStreamEvent(event);
      const chatMessages = convertCodexEventToChatMessages(transformed);
      if (chatMessages.length > 0) {
        this.emitMessages(execution.chatId, chatMessages);
      }
    }
  }

  async #activateSession(
    execution: CodexTurnExecution,
    providerSessionId: string | null | undefined,
  ): Promise<void> {
    if (!providerSessionId) return;
    const existingSession = this.#sessions.get(providerSessionId);
    if (
      execution.providerSessionId === providerSessionId &&
      existingSession?.status === 'running'
    ) {
      return;
    }

    execution.providerSessionId = providerSessionId;
    this.#sessions.set(providerSessionId, {
      thread: execution.thread,
      codex: execution.codex,
      status: 'running',
      abortController: execution.abortController,
      startedAt: new Date().toISOString(),
    });
    this.emitProcessing(execution.chatId, true);

    if (execution.emitSessionCreated && !execution.sessionCreatedEmitted) {
      this.emitSessionCreated(execution.chatId);
      execution.sessionCreatedEmitted = true;
    }

    if (execution.startedSession && !execution.startedSession.resolved) {
      const nativePath = await findCodexSessionFileBySessionId(providerSessionId);
      execution.startedSession.resolved = true;
      execution.startedSession.resolve({ providerSessionId, nativePath });
    }
  }

  #isAborted(providerSessionId: string): boolean {
    const session = this.#sessions.get(providerSessionId);
    return Boolean(session && session.status === 'aborted');
  }

  abort(providerSessionId: string): boolean {
    const session = this.#sessions.get(providerSessionId);

    if (!session) {
      return false;
    }

    session.status = 'aborted';
    try {
      session.abortController?.abort();
    } catch (error: any) {
      console.warn(`codex: failed to abort session ${providerSessionId}:`, error);
    }

    return true;
  }

  isRunning(providerSessionId: string): boolean {
    const session = this.#sessions.get(providerSessionId);
    return session?.status === 'running';
  }

  getRunningSessions(): Array<{ id: string; status: string; startedAt: string }> {
    return Array.from(this.#sessions.entries())
      .filter(([, session]) => session.status === 'running')
      .map(([id, session]) => ({ id, status: session.status, startedAt: session.startedAt }));
  }

  startPurgeTimer(): ReturnType<typeof setInterval> {
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
