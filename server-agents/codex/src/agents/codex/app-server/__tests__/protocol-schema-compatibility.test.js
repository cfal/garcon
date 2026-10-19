import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveCodexCli } from '../cli.ts';
import { convertCodexAppServerItem } from '../converter.ts';
import { parseThreadItemsListResponse, parseThreadTurnsListResponse } from '../protocol.ts';

const itemFields = {
  userMessage: { content: [{ type: 'text', text: 'Synthetic input.' }] },
  hookPrompt: { fragments: [] },
  agentMessage: { text: 'Synthetic answer.' },
  functionCallOutput: { name: 'lookup', namespace: null, output: 'Synthetic result.' },
  plan: { text: 'Synthetic plan.' },
  reasoning: { summary: ['Synthetic reasoning.'], content: [] },
  commandExecution: {
    command: 'printf synthetic', cwd: '/synthetic', status: 'completed',
    commandActions: [], aggregatedOutput: 'synthetic', exitCode: 0,
  },
  fileChange: { changes: [], status: 'completed' },
  mcpToolCall: { server: 'synthetic', tool: 'lookup', status: 'completed', arguments: {}, result: null },
  dynamicToolCall: { tool: 'lookup', namespace: null, status: 'completed', arguments: {}, contentItems: [], success: true },
  collabAgentToolCall: {
    tool: 'spawnAgent', status: 'completed', senderThreadId: 'root',
    receiverThreadIds: ['child'], agentsStates: {},
  },
  subAgentActivity: { kind: 'completed', agentThreadId: 'child', agentPath: '/root/worker' },
  webSearch: { query: 'synthetic', action: null },
  imageView: { path: '/synthetic/image.png' },
  sleep: { durationMs: 1 },
  imageGeneration: { status: 'completed', result: 'synthetic' },
  enteredReviewMode: { review: 'Synthetic review.' },
  exitedReviewMode: { review: 'Synthetic review.' },
  contextCompaction: {},
};

describe('bundled Codex experimental schema compatibility', () => {
  let directory;
  let definitions;

  beforeAll(async () => {
    directory = await mkdtemp(join(homedir(), '.garcon-codex-schema-'));
    const cli = await resolveCodexCli({ env: {} });
    expect(cli.source).toBe('bundled');
    const child = Bun.spawn([
      cli.command, 'app-server', 'generate-json-schema', '--experimental', '--out', directory,
    ], {
      env: { ...process.env, HOME: directory, CODEX_HOME: directory },
      stdout: 'ignore', stderr: 'pipe',
    });
    try {
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited, stderr).toBe(0);
      definitions = (await Bun.file(join(directory, 'codex_app_server_protocol.v2.schemas.json')).json()).definitions;
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  });

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('strictly decodes and converts every published thread item variant', () => {
    const types = definitions.ThreadItem.oneOf.flatMap((variant) => variant.properties.type.enum);
    expect(types.toSorted()).toEqual(Object.keys(itemFields).toSorted());
    for (const type of types) {
      const item = { type, id: `synthetic-${type}`, ...itemFields[type] };
      const parsed = decodeItem(item);
      expect(parsed).toEqual(item);
      expect(convertCodexAppServerItem(parsed).some((message) => message.type === 'unknown-tool-use')).toBe(false);
    }
    expect(() => decodeItem({ type: 'futureItem', id: 'synthetic' })).toThrow('Unsupported Codex thread item type');
  });

  it('decodes published collaboration tools, statuses, and late child activities', () => {
    for (const tool of definitions.CollabAgentTool.enum) {
      for (const status of definitions.CollabAgentToolCallStatus.enum) {
        const agentsStates = Object.fromEntries(definitions.CollabAgentStatus.enum.map((agentStatus) => [
          agentStatus, { status: agentStatus, message: null },
        ]));
        const parsed = decodeItem({
          type: 'collabAgentToolCall', id: 'synthetic-collaboration',
          ...itemFields.collabAgentToolCall, tool, status, agentsStates,
        });
        const [message] = convertCodexAppServerItem(parsed);
        expect(message.type).toBe('codex-subagent-tool-use');
        expect(message.details.agentStates).toEqual(Object.fromEntries(
          definitions.CollabAgentStatus.enum.map((agentStatus) => [agentStatus, { status: agentStatus }]),
        ));
      }
    }
    for (const kind of definitions.SubAgentActivityKind.enum) {
      const parsed = decodeItem({
        type: 'subAgentActivity', id: 'synthetic-activity', ...itemFields.subAgentActivity, kind,
      });
      expect(convertCodexAppServerItem(parsed)[0].type).toBe('codex-subagent-tool-use');
    }
  });

  it('strictly decodes every published error discriminator', () => {
    const errors = definitions.CodexErrorInfo.anyOf.flatMap((variant) => (
      variant.enum ?? Object.keys(variant.properties ?? {}).flatMap((kind) => (
        kind === 'activeTurnNotSteerable'
          ? definitions.NonSteerableTurnKind.enum.map((turnKind) => ({ [kind]: { turnKind } }))
          : [{ [kind]: { httpStatusCode: 429 } }]
      ))
    ));
    for (const codexErrorInfo of errors) {
      const turn = {
        id: 'synthetic-turn', items: [], itemsView: 'notLoaded', status: 'failed',
        error: { message: 'Synthetic failure.', codexErrorInfo, additionalDetails: null },
        startedAt: null, completedAt: null, durationMs: null,
      };
      expect(parseThreadTurnsListResponse({ data: [turn], nextCursor: null, backwardsCursor: null }).data)
        .toEqual([turn]);
    }
  });

  it('decodes all published turn statuses, item views, and message phases', () => {
    for (const status of definitions.TurnStatus.enum) {
      for (const itemsView of definitions.TurnItemsView.oneOf.flatMap((variant) => variant.enum)) {
        const turn = {
          id: 'synthetic-turn', items: [], status, itemsView, error: null,
          startedAt: null, completedAt: null, durationMs: null,
        };
        expect(parseThreadTurnsListResponse({ data: [turn], nextCursor: null, backwardsCursor: null }).data)
          .toEqual([turn]);
      }
    }
    for (const phase of definitions.MessagePhase.oneOf.flatMap((variant) => variant.enum)) {
      const item = { type: 'agentMessage', id: 'synthetic-message', ...itemFields.agentMessage, phase };
      expect(decodeItem(item)).toEqual(item);
      expect(convertCodexAppServerItem(item)[0].type).toBe('assistant-message');
    }
  });

  it('decodes all published function output content types and image details', () => {
    const contentFields = {
      input_text: { text: 'Synthetic result.' },
      input_image: { image_url: 'https://example.invalid/synthetic.png' },
      input_audio: { audio_url: 'https://example.invalid/synthetic.wav' },
      encrypted_content: { encrypted_content: 'synthetic' },
    };
    const types = definitions.FunctionCallOutputContentItem.oneOf.flatMap((variant) => variant.properties.type.enum);
    expect(types.toSorted()).toEqual(Object.keys(contentFields).toSorted());
    const inputImage = definitions.FunctionCallOutputContentItem.oneOf.find(
      (variant) => variant.properties.type.enum.includes('input_image'),
    );
    expect(inputImage.anyOf.map((variant) => variant.required)).toEqual([['image_url'], ['file_id']]);
    // The pinned binary's inline attachment store never emits the published file-ID form.
    // https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/attachment-store/src/lib.rs#L163-L174
    // https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/image_preparation.rs#L372-L376
    expect(() => decodeItem({
      type: 'functionCallOutput', id: 'synthetic-output', ...itemFields.functionCallOutput,
      output: [{ type: 'input_image', file_id: 'synthetic-file' }],
    })).toThrow('image_url');
    const output = types.map((type) => ({ type, ...contentFields[type] }));
    for (const detail of definitions.ImageDetail.enum) {
      const item = {
        type: 'functionCallOutput', id: 'synthetic-output', ...itemFields.functionCallOutput,
        output: [...output, { type: 'input_image', ...contentFields.input_image, detail }],
      };
      const parsed = decodeItem(item);
      expect(parsed).toEqual(item);
      expect(convertCodexAppServerItem(parsed)[0].type).toBe('tool-result');
    }
  });
});

function decodeItem(item) {
  return parseThreadItemsListResponse({
    data: [{ turnId: 'synthetic-turn', item }], nextCursor: null, backwardsCursor: null,
  }).data[0].item;
}
