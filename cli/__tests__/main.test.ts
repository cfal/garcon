import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main } from '../main.js';
import type { CliOutput } from '../output.js';

const CHAT_ID = '1785337200123456';

// Local discovery stub exercises control-command routing without a workspace descriptor.
const stubDiscovery = async () => ({
  baseUrl: 'http://127.0.0.1:8080',
  instanceId: 'instance',
  localCapability: 'cap',
  workspaceDir: '/tmp/ws',
});

function capturedOutput(): {
  output: CliOutput;
  diagnostics: string[];
  results: string[];
  documents: string[];
} {
  const diagnostics: string[] = [];
  const results: string[] = [];
  const documents: string[] = [];
  return {
    diagnostics,
    results,
    documents,
    output: {
      accepted() {},
      completed() {},
      document(content) { documents.push(content); },
      result(content) { results.push(content); },
      sent() {},
      stopped() {},
      diagnostic(message) { diagnostics.push(message); },
    },
  };
}

function acceptedControlResponse(_input: string | URL | Request, init?: RequestInit): Response {
  const body = JSON.parse(String(init?.body)) as Record<string, string>;
  return Response.json({
    success: true,
    commandType: 'agent-run',
    clientRequestId: body.clientRequestId,
    chatId: body.chatId,
    turnId: 'turn-1',
    status: 'accepted',
    acceptedAt: new Date().toISOString(),
  });
}

function controlSnapshotResponse(): Response {
  return Response.json({
    observedAt: '2026-08-04T12:00:00.000Z',
    messageLimit: 1,
    chat: {
      id: CHAT_ID,
      title: 'Review',
      agentId: 'codex',
      agentOwnershipEpoch: 'epoch-1',
      carryOverRevision: 'carry-v1:0',
      model: null,
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      permissionMode: 'default',
      thinkingMode: 'none',
      projectPath: '/project',
      tags: [],
      canReloadFromNativeHistory: false,
      activity: { createdAt: null, lastActivityAt: null },
    },
    processingPhase: null,
    control: {
      serverInstanceId: 'instance',
      queue: {
        entries: [],
        steeringEntryId: null,
        recentlyDispatched: [],
        pause: null,
        reorderRevision: 0,
      },
      version: 0,
      updatedAt: null,
    },
    transcript: {
      availability: 'available',
      transcriptViewId: 'view-1',
      messages: [],
      lastOrdinal: 0,
      pageOldestOrdinal: 0,
      pageNewestOrdinal: 0,
      nextBeforeOrdinal: null,
      hasMore: false,
    },
    transientFeed: {
      serverInstanceId: 'instance',
      chatId: CHAT_ID,
      transcriptViewId: 'view-1',
      transientRevision: 0,
      rows: [],
    },
  });
}

function chatRowTargetResponse(): Response {
  return Response.json({
    success: true,
    chatId: CHAT_ID,
    transcriptViewId: 'view-1',
  });
}

function addChatRowResponse(init?: RequestInit): Response {
  const body = JSON.parse(String(init?.body)) as Record<string, string>;
  return Response.json({
    success: true,
    commandType: 'chat-row-add',
    clientRequestId: body.clientRequestId,
    clientMessageId: body.clientMessageId,
    chatId: body.chatId,
    transcriptViewId: body.transcriptViewId,
    ordinal: 7,
    presentation: body.presentation,
    format: body.format,
    disclosure: body.disclosure,
    status: 'appended',
    timestamp: '2026-08-18T12:00:00.000Z',
  });
}

describe('main', () => {
  test('status reads one snapshot without reading stdin or resolving a project path', async () => {
    const capture = capturedOutput();
    let requestedUrl = '';
    const exitCode = await main(['status', CHAT_ID, '--messages', '0', '--json'], {
      fetch: async (input) => {
        requestedUrl = String(input);
        return Response.json({
          observedAt: '2026-08-04T12:00:00.000Z',
          messageLimit: 0,
          chat: {
            id: CHAT_ID,
            title: 'Review',
            agentId: 'codex',
            agentOwnershipEpoch: 'epoch-1',
            carryOverRevision: 'carry-v1:0',
            model: null,
            apiProviderId: null,
            modelEndpointId: null,
            modelProtocol: null,
            permissionMode: 'default',
            thinkingMode: 'none',
            projectPath: '/project/that/need/not/exist',
            tags: ['cli'],
            canReloadFromNativeHistory: false,
            activity: { createdAt: null, lastActivityAt: null },
          },
          processingPhase: null,
          control: {
            serverInstanceId: 'instance',
            queue: {
              entries: [],
              steeringEntryId: null,
              recentlyDispatched: [],
              pause: null,
              reorderRevision: 0,
            },
            version: 0,
            updatedAt: null,
          },
          transcript: { availability: 'not-requested' },
          transientFeed: {
            serverInstanceId: 'instance',
            chatId: CHAT_ID,
            transcriptViewId: 'view-1',
            transientRevision: 0,
            rows: [],
          },
        });
      },
      discoverRuntime: stubDiscovery,
      readStdin: async () => { throw new Error('stdin must not be read'); },
      output: capture.output,
    });

    expect(exitCode).toBe(0);
    expect(requestedUrl).toContain(`/api/v1/chats/snapshot?chatId=${CHAT_ID}&limit=0`);
    expect(JSON.parse(capture.results[0]!)).toMatchObject({ chat: { id: CHAT_ID } });
    expect(capture.diagnostics).toEqual([]);
  });

  test('wait reads an existing receipt without reading stdin or resolving a project path', async () => {
    const capture = capturedOutput();
    let requestedUrl = '';
    const exitCode = await main([
      'wait', CHAT_ID, '--turn', 'turn-1', '--json',
    ], {
      fetch: async (input) => {
        requestedUrl = String(input);
        return Response.json({
          state: 'completed',
          chatId: CHAT_ID,
          turnId: 'turn-1',
          clientRequestId: 'request-1',
          acceptedAt: '2026-08-04T12:00:00.000Z',
          updatedAt: '2026-08-04T12:00:00.000Z',
          settledAt: '2026-08-04T12:00:00.000Z',
          output: {
            availability: 'available',
            completeness: 'complete',
            assistantMessages: ['Done'],
          },
        });
      },
      discoverRuntime: stubDiscovery,
      readStdin: async () => { throw new Error('stdin must not be read'); },
      output: capture.output,
    });

    expect(exitCode).toBe(0);
    expect(requestedUrl).toContain('/api/v1/chats/turn-receipt?');
    expect(capture.diagnostics).toEqual([]);
  });

  test('interrupts a pending stdin read before runtime discovery', async () => {
    const controller = new AbortController();
    const capture = capturedOutput();
    const result = main([
      '--agent', 'codex',
      '--model', 'gpt-5.4',
      '-',
    ], {
      signal: controller.signal,
      readStdin: () => new Promise(() => undefined),
      output: capture.output,
    });

    controller.abort(new Error('terminal interrupted'));

    await expect(result).resolves.toBe(130);
    expect(capture.diagnostics).toEqual([
      'terminal interrupted; no Garcon agent was stopped',
    ]);
  });

  test('rejects a file passed as the project directory before discovery', async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-cli-main-'));
    const file = path.join(temporaryDirectory, 'project.txt');
    await fs.writeFile(file, 'not a directory');
    const capture = capturedOutput();
    try {
      const exitCode = await main([
        '--cwd', file,
        '--agent', 'codex',
        '--model', 'gpt-5.4',
        'Review',
      ], { output: capture.output });

      expect(exitCode).toBe(2);
      expect(capture.diagnostics[0]).toContain('--cwd must identify an existing directory');
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('exits after SIGINT while a stdin pipe remains open', async () => {
    const cliEntry = path.join(import.meta.dir, '..', 'main.ts');
    // A signal delivered before the CLI installs its handler terminates the
    // process with the default disposition; retry a fresh spawn until the
    // handler owned the interrupt and reported the contract exit.
    for (let attempt = 0; ; attempt += 1) {
      const child = Bun.spawn([
        process.execPath,
        cliEntry,
        '--agent', 'codex',
        '--model', 'gpt-5.4',
        '-',
      ], {
        cwd: path.join(import.meta.dir, '..', '..'),
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const timeout = new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('CLI did not exit after SIGINT')), 3_000);
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 250));
        child.kill('SIGINT');
        const exitCode = await Promise.race([child.exited, timeout]);
        if (exitCode !== 130 && attempt < 3) continue;
        expect(exitCode).toBe(130);
        expect(await new Response(child.stderr).text()).toContain(
          'terminal interrupted; no Garcon agent was stopped',
        );
        return;
      } finally {
        child.stdin.end();
        if (child.exitCode === null) child.kill('SIGKILL');
      }
    }
  });

  test('send-async delivers to an idle chat and exits after acceptance', async () => {
    const capture = capturedOutput();
    const exitCode = await main([
      'send-async', CHAT_ID, 'Implement the review',
    ], {
      fetch: (input, init) => String(input).includes('/snapshot?')
        ? controlSnapshotResponse()
        : acceptedControlResponse(input, init),
      discoverRuntime: stubDiscovery,
      output: capture.output,
    });
    expect(exitCode).toBe(0);
    expect(capture.diagnostics).toEqual([]);
  });

  test('send-async without --allow-steer reports busy and exits 3', async () => {
    const capture = capturedOutput();
    const exitCode = await main([
      'send-async', CHAT_ID, 'Implement the review',
    ], {
      fetch: async (input) => String(input).includes('/snapshot?')
        ? controlSnapshotResponse()
        : Response.json({
          success: false,
          error: 'Chat is busy',
          errorCode: 'SESSION_BUSY',
          retryable: true,
        }, { status: 409 }),
      discoverRuntime: stubDiscovery,
      output: capture.output,
    });
    expect(exitCode).toBe(3);
    expect(capture.diagnostics[0]).toContain('--allow-steer');
  });

  test('send-async with --allow-steer steers the active turn', async () => {
    const capture = capturedOutput();
    let runCalls = 0;
    const exitCode = await main([
      'send-async', CHAT_ID, '--allow-steer', 'Also update the migration test.',
    ], {
      fetch: async (input, init) => {
        const url = String(input);
        if (url.includes('/snapshot?')) return controlSnapshotResponse();
        if (url.endsWith('/api/v1/chats/run')) {
          runCalls += 1;
          return Response.json({
            success: false,
            error: 'Chat is busy',
            errorCode: 'SESSION_BUSY',
            retryable: true,
          }, { status: 409 });
        }
        const body = JSON.parse(String(init?.body)) as Record<string, string>;
        return Response.json({
          success: true,
          commandType: 'steer',
          clientRequestId: body.clientRequestId,
          chatId: body.chatId,
          turnId: 'turn-active',
          status: 'accepted',
          acceptedAt: new Date().toISOString(),
        });
      },
      discoverRuntime: stubDiscovery,
      output: capture.output,
    });
    expect(exitCode).toBe(0);
    expect(runCalls).toBe(1);
    expect(capture.diagnostics).toEqual([]);
  });

  test('send-async rejects empty stdin content before any network submission', async () => {
    const capture = capturedOutput();
    const exitCode = await main([
      'send-async', CHAT_ID, '-',
    ], {
      fetch: async () => { throw new Error('network must not be reached'); },
      discoverRuntime: stubDiscovery,
      readStdin: async () => '   ',
      output: capture.output,
    });
    expect(exitCode).toBe(2);
    expect(capture.diagnostics[0]).toContain('message read from stdin must not be empty');
  });

  test('add-row sends positional content only through the row endpoints', async () => {
    const capture = capturedOutput();
    const requests: Array<{ url: string; body: Record<string, string> | null }> = [];
    const exitCode = await main([
      'add-row', CHAT_ID, '--type', 'error', '--title', 'Release validation',
      'Synthetic failure detail.',
    ], {
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({
          url,
          body: init?.body ? JSON.parse(String(init.body)) as Record<string, string> : null,
        });
        return init?.method === 'POST' ? addChatRowResponse(init) : chatRowTargetResponse();
      },
      discoverRuntime: stubDiscovery,
      readStdin: async () => { throw new Error('stdin must not be read'); },
      output: capture.output,
    });

    expect(exitCode).toBe(0);
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      '/api/v1/chats/rows',
      '/api/v1/chats/rows',
    ]);
    expect(requests[0]!.body).toBeNull();
    expect(requests[1]!.body).toMatchObject({
      chatId: CHAT_ID,
      transcriptViewId: 'view-1',
      presentation: { style: 'error' },
      format: 'plain',
      disclosure: 'expanded',
      title: 'Release validation',
      content: 'Synthetic failure detail.',
    });
    expect(capture.results).toEqual([
      [
        `chat id: ${CHAT_ID}`,
        'transcript view id: view-1',
        'ordinal: 7',
        'type: error',
        'format: plain',
        'disclosure: expanded',
        'status: appended',
      ].join('\n'),
    ]);
    expect(capture.results[0]).not.toContain('Synthetic failure detail.');
    expect(capture.results[0]).not.toContain('Release validation');
    expect(capture.diagnostics).toEqual([]);
  });

  test('add-row preserves stdin content and validates it before runtime discovery', async () => {
    const capture = capturedOutput();
    let submittedContent = '';
    const exitCode = await main([
      'add-row', CHAT_ID, '--type', 'notice', '-',
    ], {
      fetch: async (_input, init) => {
        if (init?.method !== 'POST') return chatRowTargetResponse();
        const body = JSON.parse(String(init.body)) as Record<string, string>;
        submittedContent = body.content!;
        return addChatRowResponse(init);
      },
      discoverRuntime: stubDiscovery,
      readStdin: async () => 'Synthetic notice.\nSecond line.\n',
      output: capture.output,
    });

    expect(exitCode).toBe(0);
    expect(submittedContent).toBe('Synthetic notice.\nSecond line.\n');

    let discovered = false;
    const invalidCapture = capturedOutput();
    const invalidExitCode = await main([
      'add-row', CHAT_ID, '--type', 'notice', '-',
    ], {
      discoverRuntime: async () => {
        discovered = true;
        return stubDiscovery();
      },
      readStdin: async () => '\ud800',
      output: invalidCapture.output,
    });

    expect(invalidExitCode).toBe(2);
    expect(discovered).toBeFalse();
    expect(invalidCapture.diagnostics).toEqual([
      'arguments: content must contain well-formed Unicode',
    ]);

    let titleDiscovery = false;
    const invalidTitleCapture = capturedOutput();
    const invalidTitleExitCode = await main([
      'add-row', CHAT_ID, '--type', 'notice', '--title', 'first\nsecond', 'content',
    ], {
      discoverRuntime: async () => {
        titleDiscovery = true;
        return stubDiscovery();
      },
      output: invalidTitleCapture.output,
    });

    expect(invalidTitleExitCode).toBe(2);
    expect(titleDiscovery).toBeFalse();
    expect(invalidTitleCapture.diagnostics).toEqual([
      'arguments: title must be a single line',
    ]);
  });

  test('add-row rejects malformed UTF-8 stdin before runtime discovery', async () => {
    const cliEntry = path.join(import.meta.dir, '..', 'main.ts');
    const child = Bun.spawn([
      process.execPath,
      cliEntry,
      'add-row', CHAT_ID, '--type', 'notice', '-',
    ], {
      cwd: path.join(import.meta.dir, '..', '..'),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    child.stdin.write(new Uint8Array([0xc3, 0x28]));
    child.stdin.end();

    expect(await child.exited).toBe(2);
    expect(await new Response(child.stderr).text()).toContain(
      'arguments: stdin must contain valid UTF-8',
    );
  });

  test('interrupts a pending add-row submission with the mutation-aware diagnostic', async () => {
    const controller = new AbortController();
    const capture = capturedOutput();
    let markPostStarted!: () => void;
    const postStarted = new Promise<void>((resolve) => {
      markPostStarted = resolve;
    });
    const result = main([
      'add-row', CHAT_ID, '--type', 'notice', 'Synthetic notice.',
    ], {
      signal: controller.signal,
      discoverRuntime: stubDiscovery,
      fetch: async (_input, init) => {
        if (init?.method !== 'POST') return chatRowTargetResponse();
        markPostStarted();
        await new Promise<never>((_resolve, reject) => {
          if (init.signal?.aborted) {
            reject(init.signal.reason);
            return;
          }
          init.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          );
        });
      },
      output: capture.output,
    });

    await postStarted;
    controller.abort(new Error('terminal interrupted'));

    await expect(result).resolves.toBe(130);
    expect(capture.diagnostics).toEqual([
      'terminal interrupted; the add-row command may have reached Garcon; inspect the chat before retrying',
    ]);
  });

  test('stop exits 0 for a satisfied outcome', async () => {
    const capture = capturedOutput();
    const exitCode = await main(['stop', CHAT_ID], {
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, string>;
        return Response.json({
          success: true,
          commandType: 'agent-stop',
          clientRequestId: body.clientRequestId,
          chatId: body.chatId,
          status: 'accepted',
          acceptedAt: new Date().toISOString(),
          outcome: 'interrupt-requested',
          control: {
            serverInstanceId: 'instance',
            queue: {
              entries: [],
              steeringEntryId: null,
              recentlyDispatched: [],
              pause: null,
              reorderRevision: 0,
            },
            version: 0,
            updatedAt: null,
          },
        });
      },
      discoverRuntime: stubDiscovery,
      output: capture.output,
    });
    expect(exitCode).toBe(0);
    expect(capture.diagnostics).toEqual([]);
  });

  test('stop exits 3 when the server reports failure', async () => {
    const capture = capturedOutput();
    const exitCode = await main(['stop', CHAT_ID], {
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, string>;
        return Response.json({
          success: true,
          commandType: 'agent-stop',
          clientRequestId: body.clientRequestId,
          chatId: body.chatId,
          status: 'accepted',
          acceptedAt: new Date().toISOString(),
          outcome: 'failed',
          control: {
            serverInstanceId: 'instance',
            queue: {
              entries: [],
              steeringEntryId: null,
              recentlyDispatched: [],
              pause: null,
              reorderRevision: 0,
            },
            version: 0,
            updatedAt: null,
          },
        });
      },
      discoverRuntime: stubDiscovery,
      output: capture.output,
    });
    expect(exitCode).toBe(3);
    expect(capture.diagnostics[0]).toContain('could not stop');
  });

  test('interrupts a send-async stdin read with the control-aware diagnostic', async () => {
    const controller = new AbortController();
    const capture = capturedOutput();
    const result = main([
      'send-async', CHAT_ID, '-',
    ], {
      signal: controller.signal,
      readStdin: () => new Promise(() => undefined),
      output: capture.output,
    });

    controller.abort(new Error('terminal interrupted'));

    await expect(result).resolves.toBe(130);
    expect(capture.diagnostics).toEqual([
      'terminal interrupted; the control command may have reached Garcon; inspect the chat before retrying',
    ]);
  });

  test('interrupts a stop command with the control-aware diagnostic', async () => {
    const controller = new AbortController();
    const capture = capturedOutput();
    const result = main(['stop', CHAT_ID], {
      signal: controller.signal,
      discoverRuntime: async () => {
        await new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
        });
        throw new Error('unreachable');
      },
      output: capture.output,
    });

    controller.abort(new Error('terminal interrupted'));

    await expect(result).resolves.toBe(130);
    expect(capture.diagnostics).toEqual([
      'terminal interrupted; the control command may have reached Garcon; inspect the chat before retrying',
    ]);
  });

  test('routes transcript export documents without mixing status output into stdout', async () => {
    const capture = capturedOutput();
    const exitCode = await main(['export', CHAT_ID, '--exclude', 'tools'], {
      discoverRuntime: stubDiscovery,
      output: capture.output,
      fetch: async () => Response.json({
        success: true,
        chatId: CHAT_ID,
        format: 'markdown',
        transcriptViewId: 'view-1',
        lastOrdinal: 3,
        generatedAt: '2026-08-23T00:00:00.000Z',
        entryCount: 1,
        totalEntryCount: 3,
        exclusions: ['tool-calls', 'tool-results'],
        omitted: [
          { category: 'tool-calls', count: 1 },
          { category: 'tool-results', count: 1 },
        ],
        document: '# Transcript\n',
      }),
    });

    expect(exitCode).toBe(0);
    expect(capture.documents).toEqual(['# Transcript\n']);
    expect(capture.results).toEqual([]);
    expect(capture.diagnostics).toEqual([]);
  });

  test('routes read-only handoff artifacts without mixing receipts into stdout', async () => {
    const capture = capturedOutput();
    const document = '<handoff-artifact/>\n';
    const exitCode = await main([
      'handoff', CHAT_ID, '--context-window-size', '131072',
    ], {
      discoverRuntime: stubDiscovery,
      output: capture.output,
      fetch: async () => Response.json({
        success: true,
        chatId: CHAT_ID,
        transcriptViewId: 'view-1',
        lastOrdinal: 3,
        generatedAt: '2026-08-26T00:00:00.000Z',
        contextWindowTokens: 131_072,
        usableTokenBudget: 98_304,
        estimatedTokens: 10,
        fold: 'handoff-v1',
        gapUnit: 'eligible-entry',
        sourceEntryCount: 0,
        eligibleEntryCount: 0,
        excludedEntryCounts: [],
        includedEntryCount: 0,
        budgetOmittedEntryCount: 0,
        abridgedEntryCount: 0,
        gapCount: 0,
        projectionTruncated: false,
        documentCodeUnits: document.length,
        document,
      }),
    });

    expect(exitCode).toBe(0);
    expect(capture.documents).toEqual([document]);
    expect(capture.results).toEqual([]);
    expect(capture.diagnostics).toEqual([]);
  });

  test('interrupts handoff artifact generation with a read-only diagnostic', async () => {
    const controller = new AbortController();
    const capture = capturedOutput();
    const result = main(['handoff', CHAT_ID], {
      signal: controller.signal,
      discoverRuntime: stubDiscovery,
      output: capture.output,
      fetch: async (_input, init) => {
        const signal = init?.signal;
        signal?.throwIfAborted();
        return await new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });

    await Promise.resolve();
    controller.abort(new Error('terminal interrupted'));

    await expect(result).resolves.toBe(130);
    expect(capture.diagnostics).toEqual([
      'terminal interrupted; no handoff artifact was written',
    ]);
  });
});
