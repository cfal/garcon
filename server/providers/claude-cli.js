// Claude CLI transport. Spawns the `claude` binary with stdin/stdout
// pipes, exchanging JSONL messages. Extends AbsProvider so all output
// flows through typed events wired in the composition root.

import crypto from 'crypto';
import { normalizeToolResultContent } from '../chats/normalize.js';
import { getClaudeBinary } from '../config.js';
import { AssistantMessage, ThinkingMessage, ToolResultMessage, PermissionRequestMessage, PermissionResolvedMessage, PermissionCancelledMessage } from '../../common/chat-types.js';
import { convertClaudeToolUse } from './converters/claude-tool-use.js';
import { AbsProvider } from './base.js';

const DEBUG_CLI = process.env.GARCON_DEBUG_CLI === '1';

// Converts a finalized CLI assistant message to ChatMessage objects.
function convertCLIMessageToChatMessages(msg) {
  if (msg.type !== 'assistant') return [];

  const chatMessages = [];
  const now = new Date().toISOString();
  const content =
    Array.isArray(msg.content) ? msg.content
      : Array.isArray(msg.message?.content) ? msg.message.content
        : [];

  for (const part of content) {
    if (part.type === 'text' && part.text?.trim()) {
      chatMessages.push(new AssistantMessage(now, part.text));
    }
    if (part.type === 'thinking' && part.thinking) {
      chatMessages.push(new ThinkingMessage(now, part.thinking));
    }
    if (part.type === 'tool_use') {
      chatMessages.push(convertClaudeToolUse(now, part));
    }
    if (part.type === 'tool_result') {
      chatMessages.push(new ToolResultMessage(now, part.tool_use_id || '', normalizeToolResultContent(part.content), Boolean(part.is_error)));
    }
  }

  return chatMessages;
}

// Runs a one-shot CLI query and returns the plain text output.
async function runSingleQuery(prompt, { model, cwd, permissionMode, ...rest } = {}) {
  const claudeBinary = getClaudeBinary();
  const args = ['--print', '--no-session-persistence'];

  if (model) args.push('--model', model);

  const effectiveMode = permissionMode || 'default';
  if (effectiveMode !== 'default') {
    if (effectiveMode === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions');
    } else {
      args.push('--permission-mode', effectiveMode);
    }
  }

  args.push('-p', prompt);

  const proc = Bun.spawn([claudeBinary, ...args], {
    cwd: cwd || process.cwd(),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });

  const chunks = [];
  const reader = proc.stdout.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch (err) {
    console.error('cli: one-shot stdout read error:', err.message);
  }

  await proc.exited;

  const decoder = new TextDecoder();
  return chunks.map((c) => decoder.decode(c, { stream: true })).join('') + decoder.decode();
}

class ClaudeProvider extends AbsProvider {
  #runningSessions = new Map();
  #pendingPermissions = new Map();
  #pendingControlRequests = new Map();

  constructor() {
    super();
  }

  #sendToCLI(sessionId, jsonl) {
    const session = this.#runningSessions.get(sessionId);
    if (!session?.process) return;
    try {
      session.process.stdin.write(jsonl + '\n');
      session.process.stdin.flush();
    } catch (err) {
      console.warn(`cli(${sessionId.slice(0, 8)}): stdin write failed:`, err.message);
    }
  }

  #routeCLIMessage(session, msg) {
    switch (msg.type) {
      case 'system':
        this.#handleSystemMessage(session, msg);
        break;

      case 'assistant': {
        const chatMessages = convertCLIMessageToChatMessages(msg);
        if (chatMessages.length > 0) {
          this.emitMessages(session.chatId, chatMessages);
        }
        break;
      }

      case 'stream_event':
        break;

      case 'result':
        this.#handleResultMessage(session, msg);
        break;

      case 'control_request':
        this.#handleControlRequest(session, msg);
        break;

      case 'control_response':
        this.#handleControlResponse(session, msg);
        break;

      case 'tool_progress':
      case 'tool_use_summary':
      case 'auth_status':
      case 'keep_alive':
        break;

      default:
        console.info('claude: unrecognized message type:', msg.type);
        break;
    }
  }

  #handleSystemMessage(session, msg) {
    if (msg.subtype === 'init') {
      console.log(`cli(${session.id.slice(0, 8)}): session initialized (msg.session_id=${msg.session_id}, msg.model=${msg.model})`);
      if (session.id !== msg.session_id) {
        throw new Error('Unexpected session ID');
      }
    }
  }

  #handleResultMessage(session, msg) {
    this.emitFinished(session.chatId, msg.is_error ? 1 : 0);

    session.isRunning = false;
    this.emitProcessing(session.chatId, false);
    if (session.turnResolve) {
      const resolve = session.turnResolve;
      session.turnResolve = null;
      resolve();
    }
  }

  // Permission lifecycle messages are emitted as regular chat messages.
  #emitPermissionMessages(chatId, messages) {
    if (!messages.length) return;
    this.emitMessages(chatId, messages);
  }

  #handleControlRequest(session, msg) {
    if (msg.request?.subtype !== 'can_use_tool') return;

    const permissionRequestId = `claude-${crypto.randomBytes(8).toString('hex')}`;
    const toolName = msg.request.tool_name || 'Unknown';

    this.#pendingPermissions.set(permissionRequestId, {
      cliRequestId: msg.request_id,
      providerSessionId: session.id,
      chatId: session.chatId,
      toolName,
      toolInput: msg.request.input,
    });

    this.#emitPermissionMessages(session.chatId, [new PermissionRequestMessage(new Date().toISOString(), permissionRequestId, toolName, msg.request.input)]);
  }

  #handleControlResponse(session, msg) {
    const reqId = msg.response?.request_id;
    const pending = this.#pendingControlRequests.get(reqId);
    if (!pending) return;
    this.#pendingControlRequests.delete(reqId);

    if (msg.response.subtype === 'error') {
      console.warn(`cli: control request failed: ${msg.response.error}`);
      return;
    }
    pending.resolve(msg.response.response ?? {});
  }

  setInternalPermissionMode(providerSessionId, mode) {
    const session = this.#runningSessions.get(providerSessionId);
    if (!session) return;

    session.currentPermissionMode = mode;

    if (session.process) {
      const requestId = crypto.randomUUID();
      this.#sendToCLI(providerSessionId, JSON.stringify({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'set_permission_mode', mode },
      }));
    }
  }

  resolveInternalToolApproval(permissionRequestId, decision) {
    const pending = this.#pendingPermissions.get(permissionRequestId);
    if (!pending) {
      console.warn('cli: resolveInternalToolApproval, no pending entry for', permissionRequestId, '(already resolved or cancelled)');
      return;
    }
    this.#pendingPermissions.delete(permissionRequestId);

    let response;
    if (decision.allow) {
      response = {
        behavior: 'allow',
        updatedInput: pending.toolInput ?? {},
      };
      if (decision.alwaysAllow) {
        response.updatedPermissions = [{
          type: 'addRules',
          rules: [{ toolName: pending.toolName }],
          behavior: 'allow',
          destination: 'session',
        }];
      }
    } else {
      response = {
        behavior: 'deny',
        message: 'Denied by user',
      };
    }

    this.#sendToCLI(pending.providerSessionId, JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: pending.cliRequestId,
        response,
      },
    }));

    this.#emitPermissionMessages(pending.chatId, [new PermissionResolvedMessage(new Date().toISOString(), permissionRequestId, Boolean(decision.allow))]);
  }

  #sendUserMessage(session, command, images) {
    let content;
    if (images?.length) {
      const blocks = [];
      for (const img of images) {
        const matches = img.data?.match?.(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: matches[1], data: matches[2] },
          });
        }
      }
      blocks.push({ type: 'text', text: command });
      content = blocks;
    } else {
      content = command;
    }

    const jsonl = JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: session.id || '',
    });

    this.#sendToCLI(session.id, jsonl);
  }

  #waitForTurnComplete(session) {
    if (!session.isRunning) return Promise.resolve();

    return new Promise(resolve => {
      session.turnResolve = resolve;

      if (session.process) {
        session.process.exited.then(exitCode => {
          if (session.isRunning) {
            session.isRunning = false;
            this.emitProcessing(session.chatId, false);
            if (session.turnResolve === resolve) {
              session.turnResolve = null;
              resolve();
            }

            this.emitFailed(session.chatId, `CLI process exited with code ${exitCode}`);
          }
        });
      }
    });
  }

  #buildCLIArgs(session, { model, permissionMode, thinkingMode } = {}, resume = false) {
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
    ];

    if (model) {
      args.push('--model', model);
    }

    if (permissionMode && permissionMode !== 'default') {
      if (permissionMode === 'bypassPermissions') {
        args.push('--dangerously-skip-permissions');
      } else {
        args.push('--permission-mode', permissionMode);
      }
    }

    if (permissionMode !== 'bypassPermissions') {
      args.push('--permission-prompt-tool', 'stdio');
    }

    if (thinkingMode) {
      const effortMap = { 'think': 'low', 'think-hard': 'medium', 'think-harder': 'high', 'ultrathink': 'high' };
      const effort = effortMap[thinkingMode];
      if (effort) {
        args.push('--effort', effort);
      }
    }

    if (resume) {
      args.push('--resume', session.id);
    } else {
      args.push('--session-id', session.id);
    }

    args.push('-p', '');

    return args;
  }

  async #readStdout(session, proc) {
    if (!proc.stdout) return;
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            console.warn(`cli(${session.id.slice(0, 8)}): bad JSON: ${line.slice(0, 120)}`);
            continue;
          }
          this.#routeCLIMessage(session, msg);
        }
      }
    } catch (err) {
      if (!proc.killed) {
        console.error(`cli(${session.id.slice(0, 8)}): stdout read error:`, err.message);
      }
    } finally {
      this.#handleProcessExit(session);
    }
  }

  #handleProcessExit(session) {
    for (const [permissionRequestId, pending] of this.#pendingPermissions) {
      if (pending.providerSessionId === session.id) {
        this.#emitPermissionMessages(pending.chatId, [new PermissionCancelledMessage(new Date().toISOString(), permissionRequestId, 'cancelled')]);
        this.#pendingPermissions.delete(permissionRequestId);
      }
    }

    if (session.turnResolve) {
      session.isRunning = false;
      this.emitProcessing(session.chatId, false);
      const resolve = session.turnResolve;
      session.turnResolve = null;
      resolve();
    }
  }

  async #pipeStderr(sessionId, proc) {
    if (!proc.stderr) return;
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const line of text.split('\n')) {
          if (line.trim()) {
            if (DEBUG_CLI) console.log(`cli(${sessionId.slice(0, 8)}): stderr: ${line}`);
          }
        }
      }
    } catch { /* stream closed */ }
  }

  #spawnCLI(session, options, resume) {
    const claudeBinary = getClaudeBinary();
    const args = this.#buildCLIArgs(session, options, resume);

    console.log(`cli: spawning: ${claudeBinary} ${args.join(' ')}`);

    const proc = Bun.spawn([claudeBinary, ...args], {
      cwd: options.cwd || process.cwd(),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    });

    session.process = proc;
    this.#readStdout(session, proc);
    this.#pipeStderr(session.id, proc);

    proc.exited.then(exitCode => {
      console.log(`cli(${session.id.slice(0, 8)}): process exited (code=${exitCode})`);
      if (session.process === proc) {
        session.process = null;
      }
    });

    return proc;
  }

  async startClaudeInternalSession(command, {
    sessionId,
    chatId,
    images,
    permissionMode,
    ...restOpts
  }) {
    if (!chatId) throw new Error('chatId is required when starting a Claude session');

    const providerSessionId = sessionId || crypto.randomUUID();
    const allOpts = { sessionId: providerSessionId, chatId, images, permissionMode, ...restOpts };

    const session = {
      id: providerSessionId,
      chatId,
      isRunning: true,
      turnResolve: null,
      startTime: Date.now(),
      process: null,
      options: allOpts,
      currentPermissionMode: permissionMode || 'default',
    };
    this.#runningSessions.set(providerSessionId, session);
    this.emitProcessing(chatId, true);

    this.emitSessionCreated(chatId);

    this.#spawnCLI(session, allOpts, false);

    this.#sendUserMessage(session, command, images);

    await this.#waitForTurnComplete(session);
    return providerSessionId;
  }

  async runClaudeTurn(command, {
    sessionId: providerSessionId,
    chatId,
    images,
    permissionMode,
    ...restOpts
  } = {}) {
    if (!providerSessionId) {
      throw new Error('Cannot resume without session ID');
    }
    if (!chatId) {
      throw new Error('Cannot resume without chat ID');
    }

    const allOpts = { sessionId: providerSessionId, chatId, images, permissionMode, ...restOpts };

    let session = this.#runningSessions.get(providerSessionId);
    if (!session) {
      session = {
        id: providerSessionId,
        chatId: chatId,
        isRunning: false,
        turnResolve: null,
        startTime: Date.now(),
        process: null,
        options: allOpts,
      };
      this.#runningSessions.set(providerSessionId, session);
    } else {
      if (chatId !== session.chatId) {
        throw new Error('Chat ID mismatch');
      }
    }

    const effectiveChatId = chatId || session.chatId;
    session.chatId = effectiveChatId;
    session.isRunning = true;
    this.emitProcessing(effectiveChatId, true);

    if (!session.process) {
      this.#spawnCLI(session, { ...session.options, ...allOpts }, true);
    }

    const newMode = permissionMode || 'default';
    if (session.currentPermissionMode && newMode !== session.currentPermissionMode) {
      this.setInternalPermissionMode(providerSessionId, newMode);
    }
    session.currentPermissionMode = newMode;

    this.#sendUserMessage(session, command, images);
    await this.#waitForTurnComplete(session);
  }

  async abortClaudeInternalSession(providerSessionId) {
    const session = this.#runningSessions.get(providerSessionId);
    if (!session?.process) return false;

    this.#sendToCLI(providerSessionId, JSON.stringify({
      type: 'control_request',
      request_id: crypto.randomUUID(),
      request: { subtype: 'interrupt' },
    }));
    return true;
  }

  isClaudeInternalSessionRunning(providerSessionId) {
    const session = this.#runningSessions.get(providerSessionId);
    return session?.isRunning === true;
  }

  getRunningClaudeInternalSessions() {
    return Array.from(this.#runningSessions.entries())
      .filter(([, s]) => s.isRunning)
      .map(([id, s]) => ({
        id,
        status: 'running',
        startedAt: new Date(s.startTime).toISOString(),
      }));
  }
}

export { ClaudeProvider, convertCLIMessageToChatMessages, runSingleQuery };
