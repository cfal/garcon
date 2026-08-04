import { describe, expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoundedLog } from '../../support/bounded-log.js';
import { Deferred } from '../../support/deferred.js';
import { FakeAnthropicServer } from '../../support/fake-anthropic-server.js';
import { FakeClaudeModel } from '../../support/fake-claude-model.js';
import { FakeCodexModel } from '../../support/fake-codex-model.js';
import { FakeOpenAiServer } from '../../support/fake-openai-server.js';
import { FakeOpenAiResponsesServer } from '../../support/fake-openai-responses-server.js';
import { GarconTestClient } from '../../support/garcon-client.js';
import { redactSensitiveEnvironmentText } from '../../support/garcon-process.js';
import { fakeAnthropicRequestHeaders } from '../../support/anthropic-test-contract.js';
import {
  createCodexRolloutFileName,
  parseCodexRolloutFileName,
} from '../../support/codex-rollout-filename.js';
import { fakeOpenAiRequestHeaders } from '../../support/openai-test-contract.js';
import {
  stopLightpandaChild,
  type LightpandaStopChild,
} from '../../support/lightpanda-process.js';
import {
  assertSensitiveValuesNotPersisted,
  createIntegrationFixture,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';
import {
  assertScriptedOpenCodePlatform,
  OPENCODE_PLUGIN_SEED_FILES,
  OPENCODE_VERSION,
  writeOpenCodePluginSeed,
} from '../../support/scripted-opencode.js';
import {
  readJsonFile,
  stopChildWithEscalation,
  verifyPinnedBinaryVersion,
  writeJsonAtomic,
} from '../../support/opencode-process-supervisor.js';

class ControlledWebSocket extends EventTarget {
  readyState = 0;

  constructor() {
    super();
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
    });
  }

  close(): void {
    this.readyState = 2;
  }

  send(): void {}

  receive(data: string): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  finishClose(): void {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent('close', { code: 1000, reason: 'test complete' }));
  }
}

function anthropicStreamText(body: string): string {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)) as {
      delta?: { type?: string; text?: string };
    })
    .filter((event) => event.delta?.type === 'text_delta')
    .map((event) => event.delta?.text ?? '')
    .join('');
}

describe('integration support contracts', () => {
  test('redacts credential environment values from process diagnostics', () => {
    const text = 'key=sk-testing-secret token=auth-testing-secret path=/tmp/test-home';
    expect(redactSensitiveEnvironmentText(text, {
      OPENAI_API_KEY: 'sk-testing-secret',
      ANTHROPIC_AUTH_TOKEN: 'auth-testing-secret',
      HOME: '/tmp/test-home',
    })).toBe('key=[REDACTED] token=[REDACTED] path=/tmp/test-home');
  });

  test('rejects persisted sensitive values without echoing them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'garcon-sensitive-audit-'));
    const sensitiveValue = 'credential-value-that-must-not-escape';
    try {
      const nested = join(root, 'nested');
      await mkdir(nested);
      await writeFile(join(nested, 'safe.txt'), 'ordinary diagnostic content');
      await expect(assertSensitiveValuesNotPersisted({
        directory: root,
        diagnostics: { status: 'safe' },
        values: [sensitiveValue],
      })).resolves.toBeUndefined();

      let diagnosticError: unknown;
      try {
        await assertSensitiveValuesNotPersisted({
          directory: root,
          diagnostics: { unexpected: sensitiveValue },
          values: [sensitiveValue],
        });
      } catch (error) {
        diagnosticError = error;
      }
      expect(diagnosticError).toBeInstanceOf(Error);
      expect((diagnosticError as Error).message).toBe(
        'A sensitive integration credential was persisted by the test workflow.',
      );
      expect((diagnosticError as Error).message).not.toContain(sensitiveValue);

      await writeFile(join(nested, 'unsafe.txt'), sensitiveValue);
      let fileError: unknown;
      try {
        await assertSensitiveValuesNotPersisted({
          directory: root,
          diagnostics: { status: 'safe' },
          values: [sensitiveValue],
        });
      } catch (error) {
        fileError = error;
      }
      expect(fileError).toBeInstanceOf(Error);
      expect((fileError as Error).message).toBe(
        'A sensitive integration credential was persisted by the test workflow.',
      );
      expect((fileError as Error).message).not.toContain(sensitiveValue);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('resolves directory-derived environment once and lets resolver values win', async () => {
    const resolutionRoots: string[] = [];
    const fixture = await createIntegrationFixture({
      serverEnvironment: {
        GARCON_CONTRACT_MARKER: 'static',
        GARCON_CONTRACT_SECRET_TOKEN: 'static-secret-value',
      },
      resolveServerEnvironment: (directories) => {
        resolutionRoots.push(directories.root);
        return {
          GARCON_CONTRACT_MARKER: 'resolver',
          GARCON_CONTRACT_SECRET_TOKEN: 'resolver-secret-value',
        };
      },
    });
    try {
      expect(resolutionRoots).toEqual([fixture.dirs.root]);
      await access(join(fixture.dirs.home, 'tmp'));
      // Only the resolver value is audited on dispose, so persisting the overridden static
      // value must not fail cleanup.
      await writeFile(join(fixture.dirs.root, 'overridden.txt'), 'static-secret-value');
      await fixture.restartGarcon();
      await fixture.crashAndRestartGarcon();
      expect(resolutionRoots).toEqual([fixture.dirs.root]);
    } finally {
      await fixture.dispose();
    }
  }, 120_000);

  test('runs the post-Garcon cleanup hook before fixture-root removal', async () => {
    const observations: Array<{ rootExisted: boolean; garconRunning: boolean }> = [];
    const fixture = await createIntegrationFixture({
      afterGarconStop: async (directories) => {
        observations.push({
          rootExisted: await access(directories.root).then(() => true, () => false),
          garconRunning: false,
        });
      },
    });
    const root = fixture.dirs.root;
    await fixture.dispose();
    expect(observations).toEqual([{ rootExisted: true, garconRunning: false }]);
    await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' });

    const hookCalls: string[] = [];
    let creationError: unknown;
    try {
      await createIntegrationFixture({
        prepareWorkspace: async (directories) => {
          hookCalls.push(`prepare:${directories.root}`);
          throw new Error('deliberate create failure');
        },
        afterGarconStop: async (directories) => {
          hookCalls.push(`cleanup:${directories.root}`);
        },
      });
    } catch (error) {
      creationError = error;
    }
    expect((creationError as Error).message).toContain('deliberate create failure');
    expect(hookCalls).toHaveLength(2);
    expect(hookCalls[0].replace('prepare:', '')).toBe(hookCalls[1].replace('cleanup:', ''));
  }, 120_000);

  test('includes diagnostic extensions in failure artifacts', async () => {
    let failure: unknown;
    try {
      await withIntegrationFixture('support-contract-extensions', async () => {
        throw new Error('deliberate diagnostics failure');
      }, {
        extraDiagnostics: (directories) => ({ marker: 'extension-value', root: directories.root }),
      });
    } catch (error) {
      failure = error;
    }
    expect((failure as Error).message).toContain('deliberate diagnostics failure');
    const artifactMatch = /Integration diagnostics: (\S+)/.exec((failure as Error).message);
    expect(artifactMatch).not.toBeNull();
    const artifact = JSON.parse(await readFile(artifactMatch![1], 'utf8')) as {
      extensions?: { marker?: string };
    };
    expect(artifact.extensions?.marker).toBe('extension-value');
    await rm(artifactMatch![1], { force: true });
  }, 120_000);

  test('escalates a stuck supervised child from SIGTERM to SIGKILL', async () => {
    const child = Bun.spawn(
      ['sh', '-c', 'trap "" TERM; sleep 30'],
      { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
    );
    const started = Date.now();
    const exitCode = await stopChildWithEscalation(child, 50);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(exitCode).not.toBe(0);
  });

  test('reads only complete atomic JSON snapshots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'garcon-atomic-json-'));
    try {
      const path = join(root, 'state.json');
      expect(await readJsonFile(path)).toBeNull();
      const writes: Promise<void>[] = [];
      for (let index = 0; index < 50; index += 1) {
        writes.push(writeJsonAtomic(path, { index, payload: 'x'.repeat(2_000) }));
      }
      await Promise.all(writes);
      const snapshot = await readJsonFile<{ index: number; payload: string }>(path);
      expect(snapshot?.payload).toHaveLength(2_000);
      await writeFile(path, '{"torn":');
      await expect(readJsonFile(path)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('seeds consistent plugin bootstrap metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'garcon-plugin-seed-'));
    try {
      const globalConfig = join(root, 'xdg-config', 'opencode');
      await mkdir(globalConfig, { recursive: true });
      await writeOpenCodePluginSeed(globalConfig);
      await access(join(globalConfig, 'node_modules'));
      const pkg = JSON.parse(await readFile(join(globalConfig, 'package.json'), 'utf8'));
      const lock = JSON.parse(await readFile(join(globalConfig, 'package-lock.json'), 'utf8'));
      const declared = Object.keys(pkg.dependencies ?? {});
      const locked = Object.keys(lock.packages?.['']?.dependencies ?? {});
      expect(declared).toContain('@opencode-ai/plugin');
      expect(locked).toEqual(expect.arrayContaining(declared));
      expect(pkg.dependencies['@opencode-ai/plugin']).toBe(OPENCODE_VERSION);
      for (const [name, contents] of Object.entries(OPENCODE_PLUGIN_SEED_FILES)) {
        expect(await readFile(join(globalConfig, name), 'utf8')).toBe(contents);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('refuses the scripted OpenCode tier off Linux and verifies pinned versions hermetically', async () => {
    expect(() => assertScriptedOpenCodePlatform('linux')).not.toThrow();
    expect(() => assertScriptedOpenCodePlatform('darwin')).toThrow('require Linux');

    const root = await mkdtemp(join(tmpdir(), 'garcon-version-check-'));
    try {
      const good = join(root, 'good-opencode');
      await writeFile(good, `#!/bin/sh\necho ${OPENCODE_VERSION}\n`, { mode: 0o755 });
      await expect(verifyPinnedBinaryVersion({ binary: good, env: {} }))
        .resolves.toBe(OPENCODE_VERSION);

      const bad = join(root, 'bad-opencode');
      await writeFile(bad, '#!/bin/sh\necho 0.0.0\n', { mode: 0o755 });
      await expect(verifyPinnedBinaryVersion({ binary: bad, env: {} }))
        .rejects.toThrow(OPENCODE_VERSION);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('settles deferred values only once', async () => {
    const deferred = new Deferred<string>();
    expect(deferred.resolve('first')).toBe(true);
    expect(deferred.resolve('second')).toBe(false);
    expect(deferred.reject(new Error('ignored'))).toBe(false);
    expect(await deferred.promise).toBe('first');
  });

  test('retains only the newest bounded log entries', () => {
    const log = new BoundedLog<number>(2);
    log.push(1);
    log.push(2);
    log.push(3);
    expect(log.values()).toEqual([2, 3]);
  });

  test('matches the pinned Codex rollout filename contract', () => {
    const threadId = 'ec12a984-cbd3-4b3b-9203-9377c3ec665e';
    const fileName = createCodexRolloutFileName(threadId, new Date('2026-07-24T11:26:22.999Z'));

    expect(fileName).toBe(`rollout-2026-07-24T11-26-22-${threadId}.jsonl`);
    expect(parseCodexRolloutFileName(fileName)).toMatchObject({ threadId });
    expect(parseCodexRolloutFileName(`${threadId}.jsonl`)).toBeNull();
    expect(parseCodexRolloutFileName(`rollout-invalid-${threadId}.jsonl`)).toBeNull();
    expect(parseCodexRolloutFileName('rollout-2026-07-24T11-26-22-not-a-uuid.jsonl')).toBeNull();
    expect(parseCodexRolloutFileName(`rollout-2026-02-30T11-26-22-${threadId}.jsonl`)).toBeNull();
  });

  test('forces a stuck Lightpanda process down without failing the scenario', async () => {
    const exited = new Deferred<number>();
    const signals: Array<'SIGTERM' | 'SIGKILL'> = [];
    const child = {
      exited: exited.promise,
      kill(signal) {
        signals.push(signal);
        if (signal === 'SIGKILL') exited.resolve(137);
      },
    } satisfies LightpandaStopChild;

    await stopLightpandaChild(child, () => '(test logs)', 1);

    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  test('serves models and deterministic streaming echoes', async () => {
    const fake = FakeOpenAiServer.start({ defaultDelayMs: 0 });
    try {
      const models = await fetch(`${fake.baseUrl}/v1/models`, {
        headers: fakeOpenAiRequestHeaders(),
      }).then((response) => response.json());
      expect(models).toMatchObject({ data: [{ id: 'integration-echo' }] });

      const response = await fetch(`${fake.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: fakeOpenAiRequestHeaders(),
        body: JSON.stringify({
          model: 'integration-echo',
          messages: [{ role: 'user', content: 'hello' }],
          stream: true,
        }),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('echo:');
      expect(text).toContain('hello');
      expect(text).toContain('data: [DONE]');
      expect(fake.requests()).toHaveLength(1);
      expect(fake.requests()[0].lastUserText).toBe('hello');
      fake.assertNoProtocolViolations();
    } finally {
      fake.stop();
    }
  });

  test('serves strict OpenAI Responses streaming echoes', async () => {
    const fake = FakeOpenAiResponsesServer.start({ defaultDelayMs: 0 });
    try {
      const models = await fetch(`${fake.baseUrl}/v1/models`, {
        headers: fakeOpenAiRequestHeaders(),
      }).then((response) => response.json());
      expect(models).toMatchObject({ data: [{ id: 'integration-responses-echo' }] });

      const response = await fetch(`${fake.baseUrl}/v1/responses`, {
        method: 'POST',
        headers: fakeOpenAiRequestHeaders(),
        body: JSON.stringify({
          model: 'integration-responses-echo',
          input: [{ role: 'user', content: 'hello' }],
          stream: true,
          store: false,
          reasoning: { effort: 'high' },
        }),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('response.reasoning_summary_text.delta');
      expect(text).toContain('response.output_text.delta');
      expect(text).toContain('response.completed');
      expect(fake.requests()[0].body).toMatchObject({
        stream: true,
        store: false,
        reasoning: { effort: 'high' },
      });
      expect(fake.requests()[0].lastUserText).toBe('hello');
      fake.assertNoProtocolViolations();
    } finally {
      fake.stop();
    }
  });

  test('projects ordered Claude user text and cursor-relative requests', async () => {
    const fake = FakeClaudeModel.start();
    try {
      fake.scriptTurn([]);
      const cursor = fake.markRequests();
      const response = await fetch(`${fake.baseUrl}/v1/messages`, {
        method: 'POST',
        body: JSON.stringify({
          model: 'scripted',
          messages: [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'reply' },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'second' },
                { type: 'text', text: 'third' },
              ],
            },
          ],
        }),
      });
      await response.text();

      expect(fake.requestsSince(cursor)).toHaveLength(1);
      expect(fake.requestsSince(cursor)[0]).toMatchObject({
        userTexts: ['first', 'second\nthird'],
        lastUserText: 'second\nthird',
      });
      fake.assertSettled();
    } finally {
      fake.stop();
    }
  });

  test('projects ordered Codex user text and cursor-relative requests', async () => {
    const fake = FakeCodexModel.start();
    try {
      fake.scriptTurn([]);
      const cursor = fake.markRequests();
      const response = await fetch(fake.responsesUrl, {
        method: 'POST',
        body: JSON.stringify({
          model: 'scripted',
          input: [
            { type: 'message', role: 'user', content: 'first' },
            { type: 'message', role: 'assistant', content: 'reply' },
            {
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_text', text: 'second' },
                { type: 'input_text', text: 'third' },
              ],
            },
          ],
        }),
      });
      await response.text();

      expect(fake.requestsSince(cursor)).toHaveLength(1);
      expect(fake.requestsSince(cursor)[0]).toMatchObject({
        userTexts: ['first', 'second\nthird'],
        lastUserText: 'second\nthird',
      });
      fake.assertSettled();
    } finally {
      fake.stop();
    }
  });

  test('holds and explicitly releases a matched request', async () => {
    const fake = FakeOpenAiServer.start({ defaultDelayMs: 0 });
    try {
      const held = fake.holdNext({ lastUserText: 'held' });
      const responsePromise = fetch(`${fake.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: fakeOpenAiRequestHeaders(),
        body: JSON.stringify({
          model: 'integration-echo',
          messages: [{ role: 'user', content: 'held' }],
          stream: true,
        }),
      });
      expect((await held.received).lastUserText).toBe('held');
      held.releaseText('released');
      const body = await (await responsePromise).text();
      const streamed = body
        .split('\n')
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice(6)) as { choices: Array<{ delta: { content: string } }> })
        .map((event) => event.choices[0].delta.content)
        .join('');
      expect(streamed).toBe('released');
    } finally {
      fake.stop();
    }
  });

  test('models truncation as valid SSE that closes before the completion sentinel', async () => {
    const fake = FakeOpenAiServer.start({ defaultDelayMs: 0 });
    try {
      fake.truncateNextStream({ lastUserText: 'truncate' });
      const response = await fetch(`${fake.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: fakeOpenAiRequestHeaders(),
        body: JSON.stringify({
          model: 'integration-echo',
          messages: [{ role: 'user', content: 'truncate' }],
          stream: true,
        }),
      });
      const body = await response.text();
      const data = body
        .split('\n')
        .find((line) => line.startsWith('data: {'));

      expect(data).toBeString();
      expect(() => JSON.parse(data!.slice(6))).not.toThrow();
      expect(body).toContain('partial');
      expect(body).not.toContain('[DONE]');
      fake.assertNoProtocolViolations();
    } finally {
      fake.stop();
    }
  });

  test('records unsupported requests as protocol violations', async () => {
    const fake = FakeOpenAiServer.start({ defaultDelayMs: 0 });
    try {
      const response = await fetch(`${fake.baseUrl}/unexpected`);
      expect(response.status).toBe(400);
      expect(fake.protocolViolations()).toHaveLength(1);
      expect(() => fake.assertNoProtocolViolations()).toThrow('protocol violations');
    } finally {
      fake.stop();
    }
  });

  test('requires provider authentication and JSON media types', async () => {
    const fake = FakeOpenAiServer.start({ defaultDelayMs: 0 });
    try {
      const missingAuth = await fetch(`${fake.baseUrl}/v1/models`);
      expect(missingAuth.status).toBe(400);
      const wrongMediaType = await fetch(`${fake.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: fakeOpenAiRequestHeaders().authorization,
          'content-type': 'text/plain',
        },
        body: '{}',
      });
      expect(wrongMediaType.status).toBe(400);
      expect(fake.protocolViolations()).toHaveLength(2);
    } finally {
      fake.stop();
    }
  });

  test('requires consumed holds to be released or explicitly aborted', async () => {
    const fake = FakeOpenAiServer.start({ defaultDelayMs: 0 });
    try {
      const held = fake.holdNext({ lastUserText: 'unresolved' });
      const response = fetch(`${fake.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: fakeOpenAiRequestHeaders(),
        body: JSON.stringify({
          model: 'integration-echo',
          messages: [{ role: 'user', content: 'unresolved' }],
          stream: true,
        }),
      });
      await held.received;
      expect(() => fake.assertNoProtocolViolations()).toThrow('remained unresolved');
      held.releaseText('resolved');
      await response;
      fake.assertNoProtocolViolations();
    } finally {
      fake.stop();
    }
  });

  test('tracks expected aborts and rejects a late held release attempt', async () => {
    const fake = FakeOpenAiServer.start({ defaultDelayMs: 0 });
    try {
      const held = fake.holdNext({ lastUserText: 'abort-me' });
      const controller = new AbortController();
      const response = fetch(`${fake.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: fakeOpenAiRequestHeaders(),
        signal: controller.signal,
        body: JSON.stringify({
          model: 'integration-echo',
          messages: [{ role: 'user', content: 'abort-me' }],
          stream: true,
        }),
      }).catch((error) => error);
      await held.received;
      const aborted = held.expectAbort();
      controller.abort();
      expect((await aborted).lastUserText).toBe('abort-me');
      expect(held.releaseText('stale')).toBe(false);
      await response;
      fake.assertNoProtocolViolations();
    } finally {
      fake.stop();
    }
  });

  test('keeps malformed WebSocket traffic sticky through reconnect and close', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request, bunServer) {
        if (new URL(request.url).pathname === '/ws' && bunServer.upgrade(request)) return;
        return new Response('not found', { status: 404 });
      },
      websocket: {
        message(ws) {
          ws.send(JSON.stringify({ type: 'not-a-garcon-message' }));
        },
      },
    });
    let client: GarconTestClient | null = null;
    try {
      client = await GarconTestClient.connect(`http://${server.hostname}:${server.port}`);
      await expect(client.ping()).rejects.toThrow('Unknown or malformed WebSocket payload');
      await expect(client.reconnect()).rejects.toThrow('Unknown or malformed WebSocket payload');
      await expect(client.close()).rejects.toThrow('Unknown or malformed WebSocket payload');
    } finally {
      await client?.disconnect().catch(() => undefined);
      server.stop(true);
    }
  });

  test('retains a malformed frame already in flight during the close handshake', async () => {
    let socket: ControlledWebSocket | null = null;
    const client = await GarconTestClient.connect('http://garcon.test', {
      createWebSocket: () => {
        socket = new ControlledWebSocket();
        return socket;
      },
    });

    const close = client.close();
    socket!.receive(JSON.stringify({ type: 'not-a-garcon-message' }));
    socket!.finishClose();

    await expect(close).rejects.toThrow('Unknown or malformed WebSocket payload');
  });

  test('redacts credential-backed event diagnostics without changing live events', async () => {
    const privateContent = 'private provider prompt and response';
    let socket: ControlledWebSocket | null = null;
    const client = await GarconTestClient.connect('http://garcon.test', {
      createWebSocket: () => {
        socket = new ControlledWebSocket();
        return socket;
      },
      redactSensitiveDiagnostics: true,
    });
    const received = client.waitForEvent(
      (event) => event.type === 'chat-messages',
      'redacted credential-backed event',
    );

    socket!.receive(JSON.stringify({
      type: 'chat-messages',
      chatId: 'private-chat',
      generationId: 'private-generation',
      messages: [{
        seq: 1,
        message: {
          type: 'assistant-message',
          timestamp: '2026-07-26T00:00:00.000Z',
          content: privateContent,
        },
      }],
    }));

    const event = await received;
    expect(event.type).toBe('chat-messages');
    if (event.type !== 'chat-messages') throw new Error('Expected a chat messages event.');
    const message = event.messages[0]?.message;
    expect(message?.type).toBe('assistant-message');
    if (message?.type !== 'assistant-message') throw new Error('Expected an assistant message.');
    expect(message.content).toBe(privateContent);
    expect(client.describeEvents()).not.toContain(privateContent);
    expect(JSON.stringify(client.eventRecords())).not.toContain(privateContent);
    expect(client.describeEvents()).toContain('[REDACTED]');

    const close = client.close();
    socket!.finishClose();
    await close;
  });

  test('waits for a matching request strictly after the supplied cursor', async () => {
    const fake = FakeOpenAiServer.start({ defaultDelayMs: 0 });
    const request = () => fetch(`${fake.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: fakeOpenAiRequestHeaders(),
      body: JSON.stringify({
        model: 'integration-echo',
        messages: [{ role: 'user', content: 'cursor' }],
        stream: true,
      }),
    }).then((response) => response.text());
    try {
      await request();
      const firstId = fake.requests()[0].id;
      const nextRequest = fake.waitForRequest({ lastUserText: 'cursor' }, { afterId: firstId });
      await request();
      expect((await nextRequest).id).toBeGreaterThan(firstId);
      fake.assertNoProtocolViolations();
    } finally {
      fake.stop();
    }
  });

  test('reports unused response plans during teardown validation', () => {
    const fake = FakeOpenAiServer.start({ defaultDelayMs: 0 });
    try {
      fake.failNextHttp({ lastUserText: 'never-sent' }, 500, 'unused');
      expect(() => fake.assertNoProtocolViolations()).toThrow('Unused fake-provider response plans');
    } finally {
      fake.stop();
    }
  });

  test('serves Anthropic models and complete named streaming events', async () => {
    const fake = FakeAnthropicServer.start({ defaultDelayMs: 0 });
    try {
      const modelsResponse = await fetch(`${fake.baseUrl}/v1/models?limit=1000&after_id=previous`, {
        headers: fakeAnthropicRequestHeaders(),
      });
      expect(modelsResponse.status).toBe(200);
      expect(await modelsResponse.json()).toEqual({
        data: [{
          type: 'model',
          id: 'integration-anthropic-echo',
          display_name: 'Integration Anthropic Echo',
          created_at: '2026-01-01T00:00:00Z',
        }],
        has_more: false,
        first_id: 'integration-anthropic-echo',
        last_id: 'integration-anthropic-echo',
      });

      const response = await fetch(`${fake.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: fakeAnthropicRequestHeaders(),
        body: JSON.stringify({
          model: 'integration-anthropic-echo',
          max_tokens: 4096,
          messages: [{ role: 'user', content: 'hello' }],
          stream: true,
          output_config: { effort: 'high' },
        }),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      const names = text
        .split('\n')
        .filter((line) => line.startsWith('event: '))
        .map((line) => line.slice('event: '.length));
      expect(names).toEqual([
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ]);
      expect(text).toContain('echo:');
      expect(text).toContain('hello');
      expect(text).not.toContain('[DONE]');
      expect(fake.requests()[0].body).toMatchObject({
        model: 'integration-anthropic-echo',
        max_tokens: 4096,
        stream: true,
        output_config: { effort: 'high' },
      });
      expect(fake.requests()[0].lastUserText).toBe('hello');
      fake.assertNoProtocolViolations();
    } finally {
      fake.stop();
    }
  });

  test('serves non-streaming Anthropic Messages and normalizes omitted stream', async () => {
    const fake = FakeAnthropicServer.start({ defaultDelayMs: 0 });
    try {
      const response = await fetch(`${fake.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: fakeAnthropicRequestHeaders(),
        body: JSON.stringify({
          model: 'integration-anthropic-echo',
          max_tokens: 32,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
              },
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: 'pdf123' },
                title: 'report.pdf',
              },
              { type: 'text', text: 'summarize' },
            ],
          }],
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { content: Array<{ type: string; text: string }> };
      expect(body.content).toEqual([{ type: 'text', text: 'echo:summarize' }]);
      expect(fake.requests()[0].body.stream).toBe(false);
      expect(fake.requests()[0].lastUserText).toBe('summarize');
      expect(fake.diagnosticRequests()[0]).toMatchObject({
        stream: false,
        messageRoles: ['user'],
      });
      expect(fake.describeRequests()).not.toContain('abc123');
      expect(fake.describeRequests()).not.toContain('pdf123');
      fake.assertNoProtocolViolations();
    } finally {
      fake.stop();
    }
  });

  test('rejects malformed Anthropic headers, queries, and message bodies', async () => {
    const fake = FakeAnthropicServer.start({ defaultDelayMs: 0 });
    try {
      const validHeaders = fakeAnthropicRequestHeaders();
      const responses = await Promise.all([
        fetch(`${fake.baseUrl}/v1/models`),
        fetch(`${fake.baseUrl}/v1/models`, {
          headers: { ...validHeaders, 'anthropic-version': '2025-01-01' },
        }),
        fetch(`${fake.baseUrl}/v1/models?limit=invalid`, { headers: validHeaders }),
        fetch(`${fake.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: { ...validHeaders, 'content-type': 'text/plain' },
          body: '{}',
        }),
        fetch(`${fake.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: validHeaders,
          body: JSON.stringify({ model: '', max_tokens: 1, messages: [] }),
        }),
        fetch(`${fake.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: validHeaders,
          body: JSON.stringify({
            model: 'integration-anthropic-echo',
            max_tokens: 0,
            messages: [{ role: 'user', content: 'invalid' }],
          }),
        }),
        fetch(`${fake.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: validHeaders,
          body: JSON.stringify({
            model: 'integration-anthropic-echo',
            max_tokens: 1,
            messages: [{ role: 'system', content: 'invalid' }],
          }),
        }),
      ]);
      expect(responses.map((response) => response.status)).toEqual([
        400, 400, 400, 400, 400, 400, 400,
      ]);
      expect(fake.protocolViolations()).toHaveLength(7);
      expect(() => fake.assertNoProtocolViolations()).toThrow('Fake Anthropic protocol violations');
    } finally {
      fake.stop();
    }
  });

  test('holds, releases, truncates, and validates Anthropic response plans', async () => {
    const fake = FakeAnthropicServer.start({ defaultDelayMs: 0 });
    const request = (content: string) => fetch(`${fake.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: fakeAnthropicRequestHeaders(),
      body: JSON.stringify({
        model: 'integration-anthropic-echo',
        max_tokens: 128,
        messages: [{ role: 'user', content }],
        stream: true,
      }),
    });
    try {
      const held = fake.holdNext({ lastUserText: 'held', stream: true });
      const heldResponse = request('held');
      expect((await held.received).lastUserText).toBe('held');
      expect(() => fake.assertNoProtocolViolations()).toThrow('remained unresolved');
      expect(held.releaseText('released')).toBe(true);
      const heldBody = await (await heldResponse).text();
      expect(anthropicStreamText(heldBody)).toBe('released');

      fake.truncateNextStream({ lastUserText: 'truncate' });
      const truncated = await (await request('truncate')).text();
      expect(anthropicStreamText(truncated)).toBe('partial');
      expect(truncated).not.toContain('event: message_stop');
      fake.assertNoProtocolViolations();

      fake.failNextHttp({ lastUserText: 'never-sent' }, 500, 'unused');
      expect(() => fake.assertNoProtocolViolations()).toThrow(
        'Unused fake Anthropic response plans',
      );
    } finally {
      fake.stop();
    }
  });

  test('tracks explicitly expected Anthropic hold aborts', async () => {
    const fake = FakeAnthropicServer.start({ defaultDelayMs: 0 });
    try {
      const held = fake.holdNext({ lastUserText: 'abort-anthropic' });
      const controller = new AbortController();
      const response = fetch(`${fake.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: fakeAnthropicRequestHeaders(),
        signal: controller.signal,
        body: JSON.stringify({
          model: 'integration-anthropic-echo',
          max_tokens: 128,
          messages: [{ role: 'user', content: 'abort-anthropic' }],
          stream: true,
        }),
      }).catch((error) => error);
      await held.received;
      const aborted = held.expectAbort();
      controller.abort();
      expect((await aborted).lastUserText).toBe('abort-anthropic');
      expect(held.releaseText('late')).toBe(false);
      await response;
      fake.assertNoProtocolViolations();
    } finally {
      fake.stop();
    }
  });
});
