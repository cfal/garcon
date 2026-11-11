import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseChatMessage } from '@garcon/common/chat-types';
import { resolveCodexCli } from '../cli.ts';
import { buildApprovalMessage, buildApprovalResponse, createPendingApproval } from '../approvals.ts';
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
  let approvalDefinitions;

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
      approvalDefinitions = (await Bun.file(join(directory, 'CommandExecutionRequestApprovalParams.json')).json()).definitions;
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

  it('preserves optional lifecycle times on every published item variant', () => {
    expect(Object.keys(definitions.ThreadItem.properties).toSorted())
      .toEqual(['completedAtMs', 'startedAtMs']);
    for (const type of Object.keys(itemFields)) {
      for (const times of [
        {},
        { startedAtMs: null, completedAtMs: null },
        { startedAtMs: 1_790_000_000_000, completedAtMs: 1_790_000_001_000 },
      ]) {
        const item = { type, id: `synthetic-${type}`, ...itemFields[type], ...times };
        expect(decodeItem(item)).toEqual(item);
        expect(convertCodexAppServerItem(item).some((message) => message.type === 'unknown-tool-use')).toBe(false);
        const timestamp = '2026-10-01T00:00:00.000Z';
        expect(convertCodexAppServerItem(item, timestamp)).toEqual(convertCodexAppServerItem({
          type, id: item.id, ...itemFields[type],
        }, timestamp));
      }
    }
    for (const field of Object.keys(definitions.ThreadItem.properties)) {
      for (const value of ['synthetic', true, {}, [], NaN, Infinity, 1.5]) {
        expect(() => decodeItem({
          type: 'contextCompaction', id: 'synthetic-invalid-time', [field]: value,
        })).toThrow(field);
      }
    }
  });

  it('decodes both generated-image representations without dropping stored file references', () => {
    const schema = definitions.ThreadItem.oneOf.find((variant) => (
      variant.properties.type.enum.includes('imageGeneration')
    ));
    expect(schema.anyOf.map((variant) => variant.required)).toEqual([['fileId'], ['result']]);
    expect(schema.properties.generationId.type).toEqual(['string', 'null']);
    for (const image of [
      { result: 'synthetic-image' },
      { fileId: 'synthetic-file' },
      { fileId: 'synthetic-file', result: '' },
    ]) {
      const item = {
        type: 'imageGeneration', id: 'synthetic-image', status: 'completed',
        revisedPrompt: null, savedPath: '/synthetic/image.png',
        inputImages: [{ path: '/synthetic/input.png', sha256: 'ab'.repeat(32) }],
        generationId: 'synthetic-generation',
        ...image,
      };
      const parsed = decodeItem(item);
      expect(parsed).toEqual(item);
      const messages = convertCodexAppServerItem(parsed);
      expect(messages).toHaveLength(1);
      const [message] = messages;
      expect(message.type).toBe('tool-result');
      expect(message.content).toEqual(image.fileId
        ? { fileId: image.fileId, savedPath: item.savedPath }
        : { raw: image.result });
      expect(parseChatMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
    }
    expect(decodeItem({
      type: 'imageGeneration', id: 'synthetic-image', status: 'completed',
      result: 'synthetic-image', savedPath: null,
    }).savedPath).toBeNull();
    for (const fields of [
      {}, { fileId: null }, { fileId: 3 }, { result: 3 },
      { fileId: 'synthetic-file', result: 3 },
      { result: 'synthetic', savedPath: 3 },
      { result: 'synthetic', generationId: 3 },
      { result: 'synthetic', inputImages: {} },
      { result: 'synthetic', inputImages: [{ path: 3, sha256: 'synthetic' }] },
      { result: 'synthetic', inputImages: [{ path: '/synthetic/input.png', sha256: 3 }] },
    ]) {
      expect(() => decodeItem({
        type: 'imageGeneration', id: 'synthetic-image', status: 'completed', ...fields,
      })).toThrow('Invalid');
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

  it('keeps function audio outputs inline despite the wider raw audio input schema', () => {
    const rawAudio = definitions.ContentItem.oneOf.find(
      (variant) => variant.properties.type.enum.includes('input_audio'),
    );
    expect(rawAudio.anyOf.map((variant) => variant.required)).toEqual([['audio_url'], ['file_id']]);
    const userAudio = definitions.UserInput.oneOf.find(
      (variant) => variant.properties.type.enum.includes('audio'),
    );
    expect(userAudio.anyOf.map((variant) => variant.required)).toEqual([['url'], ['fileId']]);
    const audio = definitions.FunctionCallOutputContentItem.oneOf.find(
      (variant) => variant.properties.type.enum.includes('input_audio'),
    );
    expect(audio.required).toEqual(['audio_url', 'type']);
    // File-backed raw audio becomes text, not audio, in function outputs.
    // https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/protocol/src/models.rs#L2292-L2300
    const output = [{ type: 'input_audio', audio_url: 'https://example.invalid/synthetic.wav' }];
    const item = { type: 'functionCallOutput', id: 'synthetic-audio', ...itemFields.functionCallOutput, output };
    const parsed = decodeItem(item);
    expect(parsed).toEqual(item);
    const [message] = convertCodexAppServerItem(parsed);
    expect(message.type).toBe('tool-result');
    expect(message.content).toEqual({ items: output });
    expect(parseChatMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
    for (const reference of [
      {}, { audio_url: null }, { audio_url: 3 }, { file_id: 'synthetic-audio-file' },
      { file_id: 'synthetic-audio-file', audio_url: 3 },
    ]) {
      expect(() => decodeItem({
        type: 'functionCallOutput', id: 'synthetic-audio', ...itemFields.functionCallOutput,
        output: [{ type: 'input_audio', ...reference }],
      })).toThrow('Invalid');
    }
  });

  it('refuses unnegotiated human-only checkpoints and unknown command approval kinds', () => {
    const kinds = approvalDefinitions.CommandExecutionApprovalKind.oneOf.flatMap((variant) => variant.enum);
    expect(kinds).toEqual(['command', 'writeStdin', 'humanCommand']);
    for (const kind of [...kinds, 'futureKind', null, 3]) {
      const pending = createPendingApproval('synthetic-chat', {
        id: 'synthetic-request', method: 'item/commandExecution/requestApproval',
        params: { threadId: 'synthetic-thread', turnId: 'synthetic-turn', itemId: 'synthetic-item', approvalId: 'synthetic-approval', kind },
      });
      if (kind === 'command' || kind === 'writeStdin') {
        expect(buildApprovalMessage(pending).requestedTool.type)
          .toBe(kind === 'writeStdin' ? 'write-stdin-tool-use' : 'bash-tool-use');
      } else {
        expect(() => buildApprovalMessage(pending)).toThrow('Unsupported Codex command approval kind');
        expect(() => buildApprovalResponse(pending, { allow: true })).toThrow('Unsupported Codex command approval kind');
      }
    }
  });
});

function decodeItem(item) {
  return parseThreadItemsListResponse({
    data: [{ turnId: 'synthetic-turn', item }], nextCursor: null, backwardsCursor: null,
  }).data[0].item;
}
