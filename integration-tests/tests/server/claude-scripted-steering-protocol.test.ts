import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  FakeClaudeModel,
  claudeText,
  claudeToolUse,
} from '../../support/fake-claude-model.js';
import { CLAUDE_BINARY } from '../../support/live-claude.js';
import { claudeContinuationRequestText } from '../../support/scripted-claude.js';

const STEERING_PREFIX = 'The user sent steering guidance for the active task:\n\n';
const createdHarnesses: DirectClaudeHarness[] = [];

afterEach(async () => {
  await Promise.all(createdHarnesses.splice(0).map((harness) => harness.dispose()));
});

describe('pinned Claude steering protocol', () => {
  test('queues following guidance before replay and keeps result boundaries', async () => {
    const harness = await createHarness();
    const originalId = crypto.randomUUID();
    const steerId = crypto.randomUUID();
    const original = marker('FOLLOWING_ORIGINAL');
    const steering = marker('FOLLOWING_STEER');
    const held = harness.model.scriptHeldTurn([claudeText(marker('FOLLOWING_REPLY'))]);
    harness.model.scriptTurn([claudeText(marker('FOLLOWING_STEER_REPLY'))]);

    await harness.send(userFrame(harness.sessionId, originalId, original));
    await held.requested;
    await harness.send(userFrame(
      harness.sessionId,
      steerId,
      `${STEERING_PREFIX}${steering}`,
      'next',
    ));
    await harness.waitFor(commandLifecycle(steerId, 'queued'), 'steering queued');
    held.release();
    await harness.waitFor(commandLifecycle(steerId, 'completed'), 'steering completed');
    await harness.waitFor(providerState('idle'), 'provider idle');

    const queuedAt = harness.messages.findIndex(commandLifecycle(steerId, 'queued'));
    const replayAt = harness.messages.findIndex(userReplay(steerId));
    const startedAt = harness.messages.findIndex(commandLifecycle(steerId, 'started'));
    expect(queuedAt).toBeGreaterThanOrEqual(0);
    expect(replayAt).toBeGreaterThan(queuedAt);
    expect(startedAt).toBeGreaterThan(queuedAt);
    expect(harness.results().map((result) => result.user_message_uuid)).toEqual([
      originalId,
      steerId,
    ]);
    expect(harness.model.requests().map((request) => request.lastUserText).at(-1))
      .toBe(claudeContinuationRequestText(`${STEERING_PREFIX}${steering}`));
    harness.model.assertSettled();
  }, 30_000);

  test('batches following guidance in FIFO native history order', async () => {
    const harness = await createHarness();
    const originalId = crypto.randomUUID();
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const first = marker('BATCH_FIRST');
    const second = marker('BATCH_SECOND');
    const held = harness.model.scriptHeldTurn([claudeText(marker('BATCH_ORIGINAL_REPLY'))]);
    harness.model.scriptTurn([claudeText(marker('BATCH_REPLY'))]);

    await harness.send(userFrame(harness.sessionId, originalId, marker('BATCH_ORIGINAL')));
    await held.requested;
    await harness.send(userFrame(harness.sessionId, firstId, `${STEERING_PREFIX}${first}`, 'next'));
    await harness.send(userFrame(harness.sessionId, secondId, `${STEERING_PREFIX}${second}`, 'next'));
    await harness.waitFor(commandLifecycle(firstId, 'queued'), 'first steering queued');
    await harness.waitFor(commandLifecycle(secondId, 'queued'), 'second steering queued');
    held.release();
    await harness.waitFor(commandLifecycle(secondId, 'completed'), 'batched steering completed');
    await harness.waitFor(providerState('idle'), 'provider idle');

    const firstReplay = harness.messages.findIndex(userReplay(firstId));
    const secondReplay = harness.messages.findIndex(userReplay(secondId));
    expect(harness.messages.findIndex(commandLifecycle(firstId, 'queued'))).toBeLessThan(firstReplay);
    expect(harness.messages.findIndex(commandLifecycle(secondId, 'queued'))).toBeLessThan(firstReplay);
    expect(secondReplay).toBeGreaterThan(firstReplay);
    expect(harness.model.requests().at(-1)?.lastUserText).toBe(claudeContinuationRequestText([
      `${STEERING_PREFIX}${first}`,
      `${STEERING_PREFIX}${second}`,
    ].join('\n')));

    const entries = await harness.waitForNativeEntries((nativeEntries) => (
      nativeEntries.some((entry) => (
        entry.type === 'user'
        && Array.isArray(asRecord(entry.message).content)
        && (asRecord(entry.message).content as unknown[]).length === 2
      ))
    ), 'batched steering native entry');
    const batched = entries.find((entry) => (
      entry.type === 'user'
      && Array.isArray(asRecord(entry.message).content)
      && (asRecord(entry.message).content as unknown[]).length === 2
    ));
    expect(asRecord(batched?.message).content).toEqual([
      { type: 'text', text: `${STEERING_PREFIX}${first}` },
      { type: 'text', text: `${STEERING_PREFIX}${second}` },
    ]);
    harness.model.assertSettled();
  }, 30_000);

  test('injects inline guidance into tool results and persists queued attachments', async () => {
    const harness = await createHarness();
    const originalId = crypto.randomUUID();
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const first = marker('INLINE_FIRST');
    const second = marker('INLINE_SECOND');
    const toolOutput = marker('INLINE_TOOL_OUTPUT');
    const held = harness.model.scriptHeldTurn([
      claudeToolUse('toolu_inline_protocol', 'Bash', { command: `printf %s ${toolOutput}` }),
    ]);
    harness.model.scriptTurn([claudeText(marker('INLINE_REPLY'))]);

    await harness.send(userFrame(harness.sessionId, originalId, marker('INLINE_ORIGINAL')));
    await held.requested;
    await harness.send(userFrame(harness.sessionId, firstId, `${STEERING_PREFIX}${first}`, 'next'));
    await harness.send(userFrame(harness.sessionId, secondId, `${STEERING_PREFIX}${second}`, 'next'));
    await harness.waitFor(commandLifecycle(firstId, 'queued'), 'first inline steering queued');
    await harness.waitFor(commandLifecycle(secondId, 'queued'), 'second inline steering queued');
    held.release();
    await harness.waitFor(commandLifecycle(secondId, 'completed'), 'inline steering completed');
    await harness.waitFor(providerState('idle'), 'provider idle');

    expect(harness.model.requests()).toHaveLength(2);
    const toolResult = harness.model.requests().at(-1)?.toolResults.find(
      (result) => result.toolUseId === 'toolu_inline_protocol',
    );
    expect(toolResult?.content).toContain(toolOutput);
    expect(toolResult?.content).toContain(first);
    expect(toolResult?.content).toContain(second);
    expect(harness.results()).toHaveLength(1);
    expect(harness.results()[0]?.user_message_uuid).toBe(originalId);

    const entries = await harness.waitForNativeEntries((nativeEntries) => (
      JSON.stringify(nativeEntries).includes(first)
      && JSON.stringify(nativeEntries).includes(second)
    ), 'inline queued-command attachments');
    const queued = entries.filter((entry) => (
      entry.type === 'attachment'
      && asRecord(entry.attachment).type === 'queued_command'
    ));
    expect(queued.map((entry) => asRecord(entry.attachment).prompt)).toEqual([
      [{ type: 'text', text: `${STEERING_PREFIX}${first}` }],
      [{ type: 'text', text: `${STEERING_PREFIX}${second}` }],
    ]);
    harness.model.assertSettled();
  }, 30_000);

  test('replays but does not enqueue or sample a duplicate native UUID', async () => {
    const harness = await createHarness();
    const originalId = crypto.randomUUID();
    const duplicateId = crypto.randomUUID();
    const first = marker('DUPLICATE_FIRST');
    const skipped = marker('DUPLICATE_SKIPPED');
    const held = harness.model.scriptHeldTurn([claudeText(marker('DUPLICATE_ORIGINAL_REPLY'))]);
    harness.model.scriptTurn([claudeText(marker('DUPLICATE_STEER_REPLY'))]);

    await harness.send(userFrame(harness.sessionId, originalId, marker('DUPLICATE_ORIGINAL')));
    await held.requested;
    await harness.send(userFrame(harness.sessionId, duplicateId, `${STEERING_PREFIX}${first}`, 'next'));
    await harness.send(userFrame(harness.sessionId, duplicateId, `${STEERING_PREFIX}${skipped}`, 'next'));
    await harness.waitFor(userReplay(duplicateId), 'duplicate replay');
    held.release();
    await harness.waitFor(commandLifecycle(duplicateId, 'completed'), 'first duplicate input completed');
    await harness.waitFor(providerState('idle'), 'provider idle');

    expect(harness.messages.filter(commandLifecycle(duplicateId, 'queued'))).toHaveLength(1);
    expect(harness.messages.filter(commandLifecycle(duplicateId, 'started'))).toHaveLength(1);
    expect(harness.messages.filter(userReplay(duplicateId))).toHaveLength(2);
    const requests = harness.model.requests();
    expect(requests.filter((request) => request.userTexts.some((text) => text.includes(first))))
      .toHaveLength(1);
    expect(requests.every((request) => request.userTexts.every((text) => !text.includes(skipped))))
      .toBe(true);
    harness.model.assertSettled();
  }, 30_000);

  test('keeps prefixed slash guidance on the model-input path', async () => {
    const harness = await createHarness();
    const originalId = crypto.randomUUID();
    const steerId = crypto.randomUUID();
    const slash = `/review ${marker('LITERAL_SLASH')}`;
    const held = harness.model.scriptHeldTurn([claudeText(marker('SLASH_ORIGINAL_REPLY'))]);
    harness.model.scriptTurn([claudeText(marker('SLASH_STEER_REPLY'))]);

    await harness.send(userFrame(harness.sessionId, originalId, marker('SLASH_ORIGINAL')));
    await held.requested;
    await harness.send(userFrame(harness.sessionId, steerId, `${STEERING_PREFIX}${slash}`, 'next'));
    await harness.waitFor(commandLifecycle(steerId, 'queued'), 'slash steering queued');
    held.release();
    await harness.waitFor(commandLifecycle(steerId, 'completed'), 'slash steering completed');
    await harness.waitFor(providerState('idle'), 'provider idle');

    expect(harness.model.requests().at(-1)?.lastUserText)
      .toBe(claudeContinuationRequestText(`${STEERING_PREFIX}${slash}`));
    harness.model.assertSettled();
  }, 30_000);

  test('expands bare slash input through Claude skill handling', async () => {
    const harness = await createHarness();
    const originalId = crypto.randomUUID();
    const steerId = crypto.randomUUID();
    const bareMarker = marker('BARE_SLASH');
    const held = harness.model.scriptHeldTurn([claudeText(marker('BARE_SLASH_ORIGINAL_REPLY'))]);
    harness.model.scriptTurn([claudeText(marker('BARE_SLASH_REVIEW_REPLY'))]);

    await harness.send(userFrame(harness.sessionId, originalId, marker('BARE_SLASH_ORIGINAL')));
    await held.requested;
    await harness.send(userFrame(harness.sessionId, steerId, `/review ${bareMarker}`, 'next'));
    await harness.waitFor(commandLifecycle(steerId, 'queued'), 'bare slash queued');
    held.release();
    await harness.waitFor(userReplay(steerId), 'bare slash replay');
    await harness.waitFor(commandLifecycle(steerId, 'completed'), 'bare slash completed');
    await harness.waitFor(providerState('idle'), 'provider idle');

    expect(harness.model.requests()).toHaveLength(2);
    const expandedReview = harness.model.requests()[1]?.lastUserText;
    expect(expandedReview).toContain(`Review target: \`${bareMarker}\``);
    expect(expandedReview).toContain('## Phase 0 — Gather the diff');
    expect(expandedReview).not.toContain(STEERING_PREFIX);
    harness.model.assertSettled();
  }, 30_000);

  test('reports queued steering UUIDs cancelled by interrupt', async () => {
    const harness = await createHarness();
    const originalId = crypto.randomUUID();
    const steerId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const held = harness.model.scriptHeldTurn([claudeText(marker('INTERRUPT_ORIGINAL_REPLY'))]);

    await harness.send(userFrame(harness.sessionId, originalId, marker('INTERRUPT_ORIGINAL')));
    await held.requested;
    await harness.send(userFrame(
      harness.sessionId,
      steerId,
      `${STEERING_PREFIX}${marker('INTERRUPT_STEER')}`,
      'next',
    ));
    await harness.waitFor(commandLifecycle(steerId, 'queued'), 'interrupt steering queued');
    await harness.send({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'interrupt', cancel_queued: true },
    });
    const response = await harness.waitFor(
      (message) => message.type === 'control_response'
        && asRecord(message.response).request_id === requestId,
      'interrupt receipt',
    );
    held.release();

    const receipt = asRecord(asRecord(response.response).response);
    expect(receipt.cancelled).toContain(steerId);
    expect(receipt.still_queued).not.toContain(steerId);
    expect(harness.messages.filter(commandLifecycle(steerId, 'started'))).toEqual([]);
    harness.allowNonzeroExit();
  }, 30_000);
});

type JsonRecord = Record<string, unknown>;

class DirectClaudeHarness {
  readonly model = FakeClaudeModel.start();
  readonly sessionId = crypto.randomUUID();
  readonly messages: JsonRecord[] = [];
  readonly #root: string;
  readonly #project: string;
  readonly #configHome: string;
  readonly #process: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  readonly #stdout: Promise<void>;
  readonly #stderr: Promise<string>;
  #parseFailure: Error | null = null;
  #disposed = false;
  #nonzeroExitAllowed = false;
  #inputClosed = false;

  private constructor(root: string, project: string, configHome: string) {
    this.#root = root;
    this.#project = project;
    this.#configHome = configHome;
    const environment = { ...process.env };
    delete environment.CLAUDECODE;
    delete environment.CLAUDE_CONFIG_DIR;
    delete environment.CLAUDE_CODE_DISABLE_TERMINAL_TITLE;
    Object.assign(environment, {
      HOME: join(root, 'home'),
      CLAUDE_CONFIG_DIR: configHome,
      ANTHROPIC_API_KEY: 'garcon-scripted-claude-key',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: this.model.baseUrl,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
    });
    this.#process = Bun.spawn([
      CLAUDE_BINARY,
      '--print',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--replay-user-messages',
      '--verbose',
      '--model', 'haiku',
      '--permission-mode', 'bypassPermissions',
      '--effort', 'low',
      `--session-id=${this.sessionId}`,
      '-p', '',
    ], {
      cwd: project,
      env: environment,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    this.#stdout = this.#readStdout();
    this.#stderr = new Response(this.#process.stderr).text();
  }

  static async create(): Promise<DirectClaudeHarness> {
    const root = await mkdtemp(join(tmpdir(), 'garcon-claude-steering-protocol-'));
    const project = join(root, 'project');
    const configHome = join(root, 'claude-config');
    await Promise.all([
      mkdir(project, { recursive: true }),
      mkdir(configHome, { recursive: true }),
      mkdir(join(root, 'home'), { recursive: true }),
    ]);
    return new DirectClaudeHarness(root, project, configHome);
  }

  async send(message: JsonRecord): Promise<void> {
    const input = this.#process.stdin;
    if (typeof input === 'number') throw new Error('Claude stdin was not piped.');
    input.write(`${JSON.stringify(message)}\n`);
    await input.flush();
  }

  async closeInput(): Promise<void> {
    if (this.#inputClosed) return;
    this.#inputClosed = true;
    const input = this.#process.stdin;
    if (typeof input !== 'number') await input.end();
  }

  async waitFor(
    predicate: (message: JsonRecord) => boolean,
    description: string,
    timeoutMs = 10_000,
  ): Promise<JsonRecord> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = this.messages.find(predicate);
      if (match) return match;
      if (this.#parseFailure) throw this.#parseFailure;
      await Bun.sleep(10);
    }
    throw new Error(`Timed out waiting for ${description}`);
  }

  results(): JsonRecord[] {
    return this.messages.filter((message) => message.type === 'result');
  }

  async nativeEntries(): Promise<JsonRecord[]> {
    const projectKey = resolve(this.#project).normalize('NFC').replace(/[^a-zA-Z0-9]/g, '-');
    const filePath = join(this.#configHome, 'projects', projectKey, `${this.sessionId}.jsonl`);
    const content = await readFile(filePath, 'utf8');
    return content.split('\n').filter(Boolean).map((line) => JSON.parse(line) as JsonRecord);
  }

  async waitForNativeEntries(
    predicate: (entries: JsonRecord[]) => boolean,
    description: string,
    timeoutMs = 10_000,
  ): Promise<JsonRecord[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const entries = await this.nativeEntries();
        if (predicate(entries)) return entries;
      } catch {
        // The CLI creates the transcript lazily after the first persisted entry.
      }
      await Bun.sleep(10);
    }
    throw new Error(`Timed out waiting for ${description}`);
  }

  allowNonzeroExit(): void {
    this.#nonzeroExitAllowed = true;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.closeInput();
    const exited = await Promise.race([
      this.#process.exited.then(() => true),
      Bun.sleep(5_000).then(() => false),
    ]);
    if (!exited) {
      this.#process.kill();
      await this.#process.exited;
    }
    await this.#stdout;
    const stderr = await this.#stderr;
    this.model.stop();
    await rm(this.#root, { recursive: true, force: true });
    if (this.#parseFailure) throw this.#parseFailure;
    if (
      !this.#nonzeroExitAllowed
      && this.#process.exitCode
      && this.#process.exitCode !== 0
      && !stderr.includes('Interrupted')
    ) {
      throw new Error(`Claude protocol probe exited ${this.#process.exitCode}: ${stderr}`);
    }
  }

  async #readStdout(): Promise<void> {
    try {
      const output = this.#process.stdout;
      if (typeof output === 'number') throw new Error('Claude stdout was not piped.');
      const reader = output.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) this.messages.push(JSON.parse(line) as JsonRecord);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) this.messages.push(JSON.parse(buffer) as JsonRecord);
    } catch (error) {
      this.#parseFailure = error instanceof Error ? error : new Error(String(error));
    }
  }
}

async function createHarness(): Promise<DirectClaudeHarness> {
  const harness = await DirectClaudeHarness.create();
  createdHarnesses.push(harness);
  return harness;
}

function userFrame(
  sessionId: string,
  uuid: string,
  text: string,
  priority?: 'next',
): JsonRecord {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid,
    ...(priority ? { priority } : {}),
  };
}

function commandLifecycle(uuid: string, state: string): (message: JsonRecord) => boolean {
  return (message) => message.type === 'command_lifecycle'
    && message.command_uuid === uuid
    && message.state === state;
}

function userReplay(uuid: string): (message: JsonRecord) => boolean {
  return (message) => message.type === 'user'
    && message.uuid === uuid
    && message.isReplay === true;
}

function providerState(state: string): (message: JsonRecord) => boolean {
  return (message) => message.type === 'system'
    && message.subtype === 'session_state_changed'
    && message.state === state;
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function marker(label: string): string {
  return `CLAUDE_PROTOCOL_STEER_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}
