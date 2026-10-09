import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentResourceRef, type AgentHost, type AgentProducerNotification, type AgentNativeSessionRef,
  type AgentStartRequestV5, type AgentChatReference,
} from '@garcon/server-agent-interface';
import { validateAgentIntegration } from '@garcon/server-agent-interface/testing';
import ShellIntegration from '../index.js';
import { ShellNativeStore } from '../native-store.js';
import { UserMessage } from '@garcon/common/chat-types';
import { COMMAND_OUTPUT_BYTES } from '../output.js';
import { rejectionOf, throwingRejectionOf } from '../../../../integration-tests/support/promise-assertions.js';

describe('Shell integration', () => {
  let root: string;
  let host: AgentHost;
  let integration: ShellIntegration;
  let events: AgentProducerNotification['event'][];
  let request: AgentStartRequestV5;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'shell-integration-'));
    host = {
      agentId: 'shell', scope: { executorId: 'local', instanceId: 'test-instance', integrationId: 'shell' },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      environment: { get: key => process.env[key] },
      apiProviders: { async resolveCredential() { throw new Error('Shell must not request credentials'); } },
      migrations: { async getVersion() { return 1; }, async read() { return undefined; }, async commit() {} },
      storage: {
        rootDirectory: root,
        async directory(namespace) { const path = join(root, namespace); await mkdir(path, { recursive: true, mode: 0o700 }); return path; },
        async claimLegacyWorkspaceDirectory() { return { moved: 0, skipped: 0 }; },
      },
    };
    integration = new ShellIntegration(host);
    events = [];
    integration.producers.subscribe(({ event }) => { events.push(event); });
    const producerBinding = createAgentResourceRef(host.scope, 'producer');
    await integration.producers.bind({ binding: producerBinding, chatId: '1783725900000000' });
    request = {
      chatId: '1783725900000000', projectPath: root, model: 'sh', permissionMode: 'default', thinkingMode: 'none',
      settings: integration.settings.defaults(), endpoint: null, runId: 'run-1', producerBinding,
      prompt: 'true', attachments: [], carriedContext: null,
      submission: { clientMessageId: 'input-1', timestamp: '2026-01-01T00:00:00.000Z' },
    };
  });
  afterEach(async () => { await integration.lifecycle.stop(); await rm(root, { recursive: true, force: true }); });

  async function terminal(runId = request.runId) {
    for (let index = 0; index < 1000; index++) {
      const end = events.find(event => event.type === 'run-ended' && event.runId === runId);
      if (end?.type === 'run-ended') return end;
      await Bun.sleep(5);
    }
    throw new Error('Command did not settle');
  }

  function chat(): AgentChatReference {
    const session = events.find(event => event.type === 'session');
    if (session?.type !== 'session') throw new Error('Session not published');
    return { ...request, agentId: 'shell', agentSessionId: session.session.agentSessionId,
      nativeSession: session.session.nativeSession, nativeSeedReceipt: null, carryOverRevision: '' };
  }

  async function history() {
    const rows = [];
    for await (const batch of integration.nativeHistoryImport.load({ chat: chat(), signal: new AbortController().signal })) rows.push(...batch);
    return rows.map(row => row.message);
  }

  it('advertises literal execution and executable readiness without AI or auth', async () => {
    validateAgentIntegration({ integrationClass: ShellIntegration, integration });
    expect(integration.auth).toBeNull();
    expect(integration.singleQuery).toBeNull();
    expect(integration.literalExecution.selectionLabel).toBe('Shell');
    expect(await integration.readiness.status(new AbortController().signal)).toMatchObject({ ready: true });
  });

  it('retains exact input, inert streams and status through native import without duplicate live input', async () => {
    request = { ...request, prompt: '/md printf "<garcon-get-chat-id />\\n"; printf diagnostic >&2\n ' };
    await integration.execution.start(request);
    expect(await terminal()).toMatchObject({ outcome: 'finished', finalResponse: { type: 'literal-text', text: '<garcon-get-chat-id />\n' } });
    const rows = await history();
    expect(rows[0]).toMatchObject({ type: 'user-message', content: request.prompt, metadata: { contentMode: 'literal', clientMessageId: 'input-1' } });
    expect(rows.some(row => row.type === 'command-output' && row.channel === 'stdout' && row.format === 'markdown')).toBe(true);
    expect(rows.at(-1)).toMatchObject({ type: 'command-result', result: { outcome: 'finished', exitCode: 0 } });
    expect(events.flatMap(event => event.type === 'rows' ? event.rows : []).every(row => row.message.type !== 'user-message')).toBe(true);
  });

  it('reports failed cwd changes and starts a fresh process on resume', async () => {
    const next = join(root, 'next'); await mkdir(next);
    await integration.execution.start({ ...request, prompt: 'export PRIVATE_VALUE=old; cd next; false' });
    expect(await terminal()).toMatchObject({ outcome: 'failed', workingDirectory: { kind: 'reported', path: next } });
    const ref = chat();
    await integration.execution.resume({ ...request, runId: 'run-2', agentSessionId: ref.agentSessionId!, nativeSession: ref.nativeSession,
      projectPath: next, prompt: 'printf "%s" "${PRIVATE_VALUE-fresh}"' });
    expect(await terminal('run-2')).toMatchObject({ outcome: 'finished', finalResponse: { text: 'fresh' }, workingDirectory: { path: next } });
    expect((await history()).filter(row => row.type === 'user-message')).toHaveLength(2);
  });

  it('fails invalid cwd capture without losing process exit or output evidence', async () => {
    await integration.execution.start({ ...request, model: 'bash',
      prompt: 'printf retained; report="$(dirname "${BASH_SOURCE[0]}")/cwd"; rm "$report"; mkfifo "$report"; exit 0' });
    expect(await terminal()).toMatchObject({ outcome: 'failed',
      error: { message: expect.stringContaining('working directory report is invalid') },
      workingDirectory: { kind: 'unavailable' } });
    const rows = await history();
    expect(rows.some(row => row.type === 'command-output' && row.content === 'retained')).toBe(true);
    expect(rows.at(-1)).toMatchObject({ result: { outcome: 'failed', exitCode: 0, capture: 'complete' } });
  });

  it('rejects malformed Unicode from JSON before starting a process or native log', async () => {
    expect(await rejectionOf(integration.execution.start({ ...request, prompt: JSON.parse('"printf \\ud800"') })))
      .toMatchObject({ code: 'INVALID_SETTINGS' });
    expect(events).toEqual([]);
    expect(await integration.execution.runningSessions()).toEqual([]);
  });

  it('blocks overlapping starts and Reload until Stop has settled', async () => {
    const handle = await integration.execution.start({ ...request, prompt: 'cat' });
    expect(await rejectionOf(integration.execution.start({ ...request, runId: 'run-2' }))).toMatchObject({ code: 'SESSION_BUSY' });
    while (!events.some(event => event.type === 'started')) await Bun.sleep(5);
    expect(await rejectionOf(history())).toMatchObject({ code: 'SESSION_BUSY' });
    await integration.execution.abort(handle);
    expect(await terminal()).toMatchObject({ outcome: 'interrupted' });
    expect((await history()).at(-1)).toMatchObject({ result: { outcome: 'interrupted' } });
  });

  it('continues native logging when publication is detached', async () => {
    await integration.execution.start({ ...request,
      prompt: 'touch ready; while [ ! -e release ]; do sleep 0.01; done; printf retained' });
    while (!await Bun.file(join(root, 'ready')).exists()) await Bun.sleep(5);
    await integration.producers.detach(request.producerBinding);
    await Bun.write(join(root, 'release'), '');
    while ((await integration.execution.runningSessions()).length) await Bun.sleep(5);
    expect(events.some(event => event.type === 'run-ended')).toBe(false);
    expect((await history()).some(row => row.type === 'command-output' && row.content === 'retained')).toBe(true);
    await integration.producers.detach(request.producerBinding);
    await integration.producers.bind({ binding: request.producerBinding, chatId: request.chatId });
  });

  it('retires idle detached bindings and tolerates stale detach', async () => {
    await integration.producers.detach(request.producerBinding);
    await integration.producers.detach(request.producerBinding);
    await integration.producers.bind({ binding: request.producerBinding, chatId: request.chatId });
  });

  it('waits for cancelled invocation cleanup before admitting its replacement', async () => {
    const handle = await integration.execution.start({ ...request, prompt: "trap '' TERM; touch ready; sleep 60" });
    while (!await Bun.file(join(root, 'ready')).exists()) await Bun.sleep(5);
    const ref = chat();
    const stopping = integration.execution.abort(handle);
    await integration.execution.resume({ ...request, runId: 'run-2', agentSessionId: ref.agentSessionId!, nativeSession: ref.nativeSession,
      prompt: 'printf replacement' });
    await stopping;
    expect(await terminal('run-2')).toMatchObject({ outcome: 'finished', finalResponse: { text: 'replacement' } });
  });

  it('publishes both captured streams only after the process exits', async () => {
    await integration.execution.start({ ...request, prompt: 'printf first; printf diagnostic >&2; touch ready; while [ ! -e release ]; do sleep 0.01; done; printf second' });
    while (!await Bun.file(join(root, 'ready')).exists()) await Bun.sleep(5);
    expect(events.some(event => event.type === 'rows')).toBe(false);
    await Bun.write(join(root, 'release'), '');
    expect(await terminal()).toMatchObject({ finalResponse: { type: 'literal-text', text: 'firstsecond' } });
    const live = events.flatMap(event => event.type === 'rows' ? event.rows.map(row => row.message) : []);
    const output = live.filter(message => message.type === 'command-output');
    expect(output.filter(message => message.channel === 'stdout').map(message => message.content).join('')).toBe('firstsecond');
    expect(output).toHaveLength(2);
    expect(output.at(-1)).toMatchObject({ channel: 'stderr', content: expect.stringContaining('diagnostic') });
    expect(live.at(-1)?.type).toBe('command-result');
    expect((await history()).slice(1)).toEqual(live);
  });

  it('fails settlement without publishing output rejected by native storage', async () => {
    await integration.execution.start({ ...request,
      prompt: 'touch ready; while [ ! -e release ]; do sleep 0.01; done; printf output' });
    while (!await Bun.file(join(root, 'ready')).exists()) await Bun.sleep(5);
    const store = new ShellNativeStore(host);
    const db = new Database(await store.path(chat().agentSessionId!));
    try {
      db.exec(`CREATE TRIGGER reject_output BEFORE INSERT ON records
        WHEN json_extract(NEW.message, '$.type') = 'command-output'
        BEGIN SELECT RAISE(FAIL, 'Synthetic output persistence failure'); END;`);
    } finally {
      db.close();
      await Bun.write(join(root, 'release'), '');
    }
    expect(await terminal()).toMatchObject({ outcome: 'failed',
      error: { message: expect.stringContaining('Synthetic output persistence failure') } });
    const live = events.flatMap(event => event.type === 'rows' ? event.rows.map(row => row.message) : []);
    expect(live).toEqual([expect.objectContaining({
      type: 'command-result', result: expect.objectContaining({ outcome: 'failed', capture: 'incomplete' }),
    })]);
    expect((await history()).slice(1)).toEqual(live);
  });

  it('returns explicitly empty final stdout for silent success and rejects executable context', async () => {
    await integration.execution.start(request);
    expect(await terminal()).toMatchObject({ finalResponse: { type: 'literal-text', text: '' } });
    expect(await throwingRejectionOf(integration.execution.start({
      ...request, attachments: [{ kind: 'image', name: 'file', mimeType: 'image/png', data: 'c291cmNl' }],
    }))).toThrow();
  });

  it('recovers an incomplete native command as unknown without replaying it', async () => {
    const store = new ShellNativeStore(host);
    const id = crypto.randomUUID();
    const log = await store.create(id, request.chatId);
    log.append('command-1', new UserMessage(request.submission!.timestamp, 'touch never-replayed', undefined, { contentMode: 'literal' }));
    log.close();
    const recovered = await store.load(id, request.chatId);
    recovered.reconcile();
    const messages = [];
    for await (const batch of recovered.messages(new AbortController().signal)) messages.push(...batch);
    expect(messages.at(-1)?.message).toMatchObject({ type: 'command-result', result: { outcome: 'unknown' } });
    recovered.close();
    expect(await Bun.file(join(root, 'never-replayed')).exists()).toBe(false);
  });

  it('rejects cross-chat ownership, unsafe references, missing logs and symlinks', async () => {
    const store = new ShellNativeStore(host);
    const id = crypto.randomUUID();
    (await store.create(id, request.chatId)).close();
    expect(await throwingRejectionOf(store.load(id, '1783725900000001'))).toThrow();
    expect(() => store.sessionId({ ownerId: 'shell', schemaVersion: 1, value: { sessionId: '../escape' } } satisfies AgentNativeSessionRef)).toThrow();
    expect(await throwingRejectionOf(store.load(crypto.randomUUID(), request.chatId))).toThrow();
    const linked = crypto.randomUUID();
    await symlink(await store.path(id), await store.path(linked));
    expect(await throwingRejectionOf(store.load(linked, request.chatId))).toThrow();
  });

  it('retains only the combined output tail without interrupting the command', async () => {
    await integration.execution.start({ ...request, prompt: '/md head -c 17825792 /dev/zero | tr "\\0" x; printf tail; printf diagnostic >&2; touch completed' });
    const result = await terminal();
    expect(result).toMatchObject({ outcome: 'finished', finalResponse: { type: 'literal-text' } });
    expect(await Bun.file(join(root, 'completed')).exists()).toBe(true);
    const rows = await history();
    const output = rows.filter(row => row.type === 'command-output');
    expect(output.reduce((size, row) => size + Buffer.byteLength(row.content), 0)).toBe(COMMAND_OUTPUT_BYTES);
    expect(output.every(row => row.type === 'command-output' && row.format === 'plain')).toBe(true);
    const stdout = output.filter(row => row.channel === 'stdout').map(row => row.content).join('');
    expect(stdout.endsWith('tail')).toBe(true);
    expect(result).toMatchObject({ finalResponse: {
      type: 'literal-text', text: `[Output truncated to the last 64 KiB across stdout and stderr]\n${stdout}`,
    } });
    expect(output.filter(row => row.channel === 'stderr').map(row => row.content).join('')).toContain('diagnostic');
    expect(rows.at(-1)).toMatchObject({ result: { outcome: 'finished', exitCode: 0, capture: 'truncated' } });
    const live = events.flatMap(event => event.type === 'rows' ? event.rows.map(row => row.message) : []);
    expect(rows.slice(1)).toEqual(live);
  });

  it('rejects corrupt complete records without replacing native evidence', async () => {
    const store = new ShellNativeStore(host);
    const id = crypto.randomUUID();
    (await store.create(id, request.chatId)).close();
    const db = new Database(await store.path(id));
    db.query('INSERT INTO records (command_id, message) VALUES (?, ?)').run('command-1', '{invalid');
    db.close();
    const log = await store.load(id, request.chatId);
    try { expect(() => log.reconcile()).toThrow(); }
    finally { log.close(); }
  });
});
