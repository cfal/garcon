import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseChatMessage } from '../../../common/chat-types.js';
import { buildApprovalMessage, buildApprovalResponse, createPendingApproval } from '../../../server-agents/codex/src/agents/codex/app-server/approvals.js';
import { convertCodexAppServerItem } from '../../../server-agents/codex/src/agents/codex/app-server/converter.js';
import { parseThreadItemsListResponse, parseThreadTurnsListResponse, type CodexThreadItem } from '../../../server-agents/codex/src/agents/codex/app-server/protocol.js';
import { CODEX_BINARY } from '../../support/pinned-agent-binaries.js';

interface SchemaNode {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, SchemaNode>;
  oneOf?: SchemaNode[];
  anyOf?: SchemaNode[];
}

const itemFields: Record<string, Record<string, unknown>> = {
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
} satisfies Record<CodexThreadItem['type'], Record<string, unknown>>;

describe('pinned external Codex experimental schema compatibility', () => {
  let directory: string;
  let definitions: Record<string, SchemaNode>;
  let approvalDefinitions: Record<string, SchemaNode>;

  beforeAll(async () => {
    directory = await mkdtemp(join(homedir(), '.garcon-codex-schema-'));
    const child = Bun.spawn([
      CODEX_BINARY, 'app-server', 'generate-json-schema', '--experimental', '--out', directory,
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
    const types = definitions.ThreadItem.oneOf!.flatMap((variant) => enumValues(variant.properties!.type));
    expect(types.toSorted()).toEqual(Object.keys(itemFields).toSorted());
    for (const type of types) {
      const item = { type, id: `synthetic-${type}`, ...itemFields[type] };
      const parsed = decodeItem(item);
      expect<unknown>(parsed).toEqual(item);
      expect(convertCodexAppServerItem(parsed).some((message) => message.type === 'unknown-tool-use')).toBe(false);
    }
    expect(() => decodeItem({ type: 'futureItem', id: 'synthetic' })).toThrow('Unsupported Codex thread item type');
  });

  it('decodes published collaboration tools, statuses, and late child activities', () => {
    for (const tool of enumValues(definitions.CollabAgentTool)) {
      for (const status of enumValues(definitions.CollabAgentToolCallStatus)) {
        const agentsStates = Object.fromEntries(enumValues(definitions.CollabAgentStatus).map((agentStatus) => [
          agentStatus, { status: agentStatus, message: null },
        ]));
        const parsed = decodeItem({
          type: 'collabAgentToolCall', id: 'synthetic-collaboration',
          ...itemFields.collabAgentToolCall, tool, status, agentsStates,
        });
        const [message] = convertCodexAppServerItem(parsed);
        expect(message.type).toBe('codex-subagent-tool-use');
        if (message.type !== 'codex-subagent-tool-use') throw new Error('Expected a subagent message');
        expect<unknown>(message.details.agentStates).toEqual(Object.fromEntries(
          enumValues(definitions.CollabAgentStatus).map((agentStatus) => [agentStatus, { status: agentStatus }]),
        ));
      }
    }
    for (const kind of enumValues(definitions.SubAgentActivityKind)) {
      const parsed = decodeItem({
        type: 'subAgentActivity', id: 'synthetic-activity', ...itemFields.subAgentActivity, kind,
      });
      expect(convertCodexAppServerItem(parsed)[0].type).toBe('codex-subagent-tool-use');
    }
  });

  it('preserves optional lifecycle times on every published item variant', () => {
    expect(Object.keys(definitions.ThreadItem.properties!).toSorted())
      .toEqual(['completedAtMs', 'startedAtMs']);
    for (const type of Object.keys(itemFields)) {
      for (const times of [
        {},
        { startedAtMs: null, completedAtMs: null },
        { startedAtMs: 1_790_000_000_000, completedAtMs: 1_790_000_001_000 },
      ]) {
        const item = { type, id: `synthetic-${type}`, ...itemFields[type], ...times };
        const parsed = decodeItem(item);
        expect<unknown>(parsed).toEqual(item);
        expect(convertCodexAppServerItem(parsed).some((message) => message.type === 'unknown-tool-use')).toBe(false);
        const timestamp = '2026-10-01T00:00:00.000Z';
        expect(convertCodexAppServerItem(parsed, timestamp)).toEqual(convertCodexAppServerItem(decodeItem({
          type, id: item.id, ...itemFields[type],
        }), timestamp));
      }
    }
    for (const field of Object.keys(definitions.ThreadItem.properties!)) {
      for (const value of ['synthetic', true, {}, [], NaN, Infinity, 1.5]) {
        expect(() => decodeItem({
          type: 'contextCompaction', id: 'synthetic-invalid-time', [field]: value,
        })).toThrow(field);
      }
    }
  });

  it('decodes both generated-image representations without dropping stored file references', () => {
    const schema = definitions.ThreadItem.oneOf!.find((variant) => (
      enumValues(variant.properties!.type).includes('imageGeneration')
    ))!;
    expect(schema.anyOf!.map((variant) => variant.required)).toEqual([['fileId'], ['result']]);
    expect(schema.properties!.generationId.type).toEqual(['string', 'null']);
    const images: Array<{ fileId?: string; result?: string }> = [
      { result: 'synthetic-image' },
      { fileId: 'synthetic-file' },
      { fileId: 'synthetic-file', result: '' },
    ];
    for (const image of images) {
      const item = {
        type: 'imageGeneration', id: 'synthetic-image', status: 'completed',
        revisedPrompt: null, savedPath: '/synthetic/image.png',
        inputImages: [{ path: '/synthetic/input.png', sha256: 'ab'.repeat(32) }],
        generationId: 'synthetic-generation',
        ...image,
      };
      const parsed = decodeItem(item);
      expect<unknown>(parsed).toEqual(item);
      const messages = convertCodexAppServerItem(parsed);
      expect(messages).toHaveLength(1);
      const [message] = messages;
      expect(message.type).toBe('tool-result');
      if (message.type !== 'tool-result') throw new Error('Expected a tool result');
      expect(message.content).toEqual(image.fileId
        ? { fileId: image.fileId, savedPath: item.savedPath }
        : { raw: image.result });
      expect(parseChatMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
    }
    const parsedImage = decodeItem({
      type: 'imageGeneration', id: 'synthetic-image', status: 'completed',
      result: 'synthetic-image', savedPath: null,
    });
    if (parsedImage.type !== 'imageGeneration') throw new Error('Expected a generated image');
    expect(parsedImage.savedPath).toBeNull();
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
    const errors = definitions.CodexErrorInfo.anyOf!.flatMap((variant) => (
      variant.enum ?? Object.keys(variant.properties ?? {}).flatMap<unknown>((kind) => (
        kind === 'activeTurnNotSteerable'
          ? enumValues(definitions.NonSteerableTurnKind).map((turnKind) => ({ [kind]: { turnKind } }))
          : [{ [kind]: { httpStatusCode: 429 } }]
      ))
    ));
    expect(errors).toContain('bioPolicy');
    for (const codexErrorInfo of errors) {
      const turn = {
        id: 'synthetic-turn', items: [], itemsView: 'notLoaded', status: 'failed',
        error: { message: 'Synthetic failure.', codexErrorInfo, additionalDetails: null },
        startedAt: null, completedAt: null, durationMs: null,
      };
      expect<unknown>(parseThreadTurnsListResponse({ data: [turn], nextCursor: null, backwardsCursor: null }).data)
        .toEqual([turn]);
    }
  });

  it('decodes all published turn statuses, item views, and message phases', () => {
    for (const status of enumValues(definitions.TurnStatus)) {
      for (const itemsView of definitions.TurnItemsView.oneOf!.flatMap(enumValues)) {
        const turn = {
          id: 'synthetic-turn', items: [], status, itemsView, error: null,
          startedAt: null, completedAt: null, durationMs: null,
        };
        expect<unknown>(parseThreadTurnsListResponse({ data: [turn], nextCursor: null, backwardsCursor: null }).data)
          .toEqual([turn]);
      }
    }
    for (const phase of definitions.MessagePhase.oneOf!.flatMap(enumValues)) {
      const item = { type: 'agentMessage', id: 'synthetic-message', ...itemFields.agentMessage, phase };
      const parsed = decodeItem(item);
      expect<unknown>(parsed).toEqual(item);
      expect(convertCodexAppServerItem(parsed)[0].type).toBe('assistant-message');
    }
  });

  it('decodes all published function output content types and image details', () => {
    const contentFields: Record<string, Record<string, unknown>> = {
      input_text: { text: 'Synthetic result.' },
      input_image: { image_url: 'https://example.invalid/synthetic.png' },
      input_audio: { audio_url: 'https://example.invalid/synthetic.wav' },
      encrypted_content: { encrypted_content: 'synthetic' },
    };
    const types = definitions.FunctionCallOutputContentItem.oneOf!.flatMap((variant) => enumValues(variant.properties!.type));
    expect(types.toSorted()).toEqual(Object.keys(contentFields).toSorted());
    const inputImage = definitions.FunctionCallOutputContentItem.oneOf!.find(
      (variant) => enumValues(variant.properties!.type).includes('input_image'),
    )!;
    expect(inputImage.anyOf!.map((variant) => variant.required)).toEqual([['image_url'], ['file_id']]);
    // The pinned binary's inline attachment store never emits the published file-ID form.
    // https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/attachment-store/src/lib.rs#L163-L174
    // https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/image_preparation.rs#L372-L376
    expect(() => decodeItem({
      type: 'functionCallOutput', id: 'synthetic-output', ...itemFields.functionCallOutput,
      output: [{ type: 'input_image', file_id: 'synthetic-file' }],
    })).toThrow('image_url');
    const output = types.map((type) => ({ type, ...contentFields[type] }));
    for (const detail of enumValues(definitions.ImageDetail)) {
      const item = {
        type: 'functionCallOutput', id: 'synthetic-output', ...itemFields.functionCallOutput,
        output: [...output, { type: 'input_image', ...contentFields.input_image, detail }],
      };
      const parsed = decodeItem(item);
      expect<unknown>(parsed).toEqual(item);
      expect(convertCodexAppServerItem(parsed)[0].type).toBe('tool-result');
    }
  });

  it('preserves inline and file-backed function audio outputs', () => {
    const rawAudio = definitions.ContentItem.oneOf!.find(
      (variant) => enumValues(variant.properties!.type).includes('input_audio'),
    )!;
    expect(rawAudio.anyOf!.map((variant) => variant.required)).toEqual([['audio_url'], ['file_id']]);
    const userAudio = definitions.UserInput.oneOf!.find(
      (variant) => enumValues(variant.properties!.type).includes('audio'),
    )!;
    expect(userAudio.anyOf!.map((variant) => variant.required)).toEqual([['url'], ['fileId']]);
    const audio = definitions.FunctionCallOutputContentItem.oneOf!.find(
      (variant) => enumValues(variant.properties!.type).includes('input_audio'),
    )!;
    expect(audio.required).toEqual(['type']);
    expect(audio.anyOf!.map((variant) => variant.required)).toEqual([['audio_url'], ['file_id']]);
    for (const reference of [
      { audio_url: 'https://example.invalid/synthetic.wav' },
      { file_id: 'synthetic-audio-file' },
    ]) {
      const output = [{ type: 'input_audio', ...reference }];
      const item = { type: 'functionCallOutput', id: 'synthetic-audio', ...itemFields.functionCallOutput, output };
      const parsed = decodeItem(item);
      expect<unknown>(parsed).toEqual(item);
      const [message] = convertCodexAppServerItem(parsed);
      expect(message.type).toBe('tool-result');
      if (message.type !== 'tool-result') throw new Error('Expected a tool result');
      expect(message.content).toEqual({ items: output });
      expect(parseChatMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
    }
    for (const reference of [
      {}, { audio_url: null }, { audio_url: 3 }, { file_id: null }, { file_id: 3 },
      { file_id: 'synthetic-audio-file', audio_url: 3 },
      { audio_url: 'https://example.invalid/synthetic.wav', file_id: 3 },
    ]) {
      expect(() => decodeItem({
        type: 'functionCallOutput', id: 'synthetic-audio', ...itemFields.functionCallOutput,
        output: [{ type: 'input_audio', ...reference }],
      })).toThrow('Invalid');
    }
  });

  it('requires complete history item output instead of importing deferred placeholders', () => {
    expect(definitions.ThreadItemEntry.properties!.outputDeferred.type).toBe('boolean');
    const entry = { turnId: 'synthetic-turn', item: { type: 'contextCompaction', id: 'synthetic-item' } };
    expect<unknown>(parseThreadItemsListResponse({ data: [{ ...entry, outputDeferred: false }] }).data).toEqual([entry]);
    for (const outputDeferred of [true, null, 'false', 0, {}]) {
      expect(() => parseThreadItemsListResponse({ data: [{ ...entry, outputDeferred }] })).toThrow('outputDeferred');
    }
  });

  it('decodes moderation metadata without interpreting provider-owned display instructions', () => {
    const agent = definitions.ThreadItem.oneOf!.find((variant) => (
      enumValues(variant.properties!.type).includes('agentMessage')
    ))!;
    expect(agent.properties!.moderation.anyOf![0].$ref).toBe('#/definitions/AgentMessageModeration');
    expect(definitions.AgentMessageModeration.required).toEqual(['moderated']);
    expect(definitions.AgentMessageModeration.properties!.moderated.type).toBe('boolean');
    expect(definitions.AgentMessageModeration.properties!.display.anyOf).toEqual([
      { $ref: '#/definitions/AgentMessageDisplay' }, { type: 'null' },
    ]);
    const displayVariants = definitions.AgentMessageDisplay.oneOf!;
    expect(displayVariants.flatMap((variant) => enumValues(variant.properties!.mode)))
      .toEqual(['show', 'hide', 'block']);
    expect(displayVariants.map((variant) => variant.required)).toEqual([
      ['mode', 'trustedContacts', 'version'], ['mode', 'replacement', 'version'], ['mode', 'reason', 'version'],
    ]);
    for (const variant of displayVariants) expect(variant.properties!.version.enum).toEqual([1]);
    const [showDisplay, hideDisplay, blockDisplay] = displayVariants;
    expect(showDisplay.properties!.trustedContacts.$ref).toBe('#/definitions/TrustedContacts');
    expect(showDisplay.properties!.annotation.anyOf).toEqual([
      { $ref: '#/definitions/AnswerAnnotation' }, { type: 'null' },
    ]);
    expect(hideDisplay.properties!.replacement.$ref).toBe('#/definitions/AnswerReplacement');
    expect(blockDisplay.properties!.reason.$ref).toBe('#/definitions/BlockReason');
    expect(definitions.AnswerAnnotation.oneOf!.flatMap((variant) => enumValues(variant.properties!.kind)))
      .toEqual(['wellbeingHelpline']);
    expect(definitions.AnswerAnnotation.oneOf![0].required).toEqual(['kind', 'subject']);
    expect(definitions.AnswerAnnotation.oneOf![0].properties!.subject.$ref).toBe('#/definitions/HelplineSubject');
    expect(definitions.AnswerReplacement.oneOf!.flatMap((variant) => enumValues(variant.properties!.kind)))
      .toEqual(['wellbeingPromptHelpline']);
    expect(definitions.AnswerReplacement.oneOf![0].required).toEqual(['kind']);
    expect(definitions.BlockReason.oneOf!.flatMap((variant) => enumValues(variant.properties!.kind)))
      .toEqual(['protection', 'cyber']);
    expect(definitions.BlockReason.oneOf!.map((variant) => variant.required))
      .toEqual([['kind', 'protectionType'], ['kind']]);
    expect(definitions.BlockReason.oneOf![0].properties!.protectionType.type).toBe('string');
    expect(definitions.BlockReason.oneOf![1].properties!.trustedAccess.type).toEqual(['boolean', 'null']);
    expect(enumValues(definitions.TrustedContacts)).toEqual(['check', 'skip']);
    expect(enumValues(definitions.HelplineSubject)).toEqual(['answer', 'prompt']);

    const displays: Record<string, unknown>[] = [
      { mode: 'hide', version: 1, replacement: { kind: 'wellbeingPromptHelpline' } },
      { mode: 'block', version: 1, reason: { kind: 'protection', protectionType: 'synthetic-protection' } },
      { mode: 'block', version: 1, reason: { kind: 'protection', protectionType: '' } },
      { mode: 'block', version: 1, reason: { kind: 'cyber' } },
      ...[null, false, true].map((trustedAccess) => ({
        mode: 'block', version: 1, reason: { kind: 'cyber', trustedAccess },
      })),
    ];
    for (const trustedContacts of enumValues(definitions.TrustedContacts)) {
      const show = { mode: 'show', version: 1, trustedContacts };
      displays.push(show, { ...show, annotation: null });
      for (const subject of enumValues(definitions.HelplineSubject)) {
        displays.push({ ...show, annotation: { kind: 'wellbeingHelpline', subject } });
      }
    }
    const timestamp = '2026-10-01T00:00:00.000Z';
    const unmoderated = {
      type: 'agentMessage', id: 'synthetic-answer', text: 'Synthetic answer.', phase: 'final_answer',
    };
    const expectedMessages = convertCodexAppServerItem(decodeItem(unmoderated), timestamp);
    for (const moderation of [
      undefined, null, { moderated: false }, { moderated: true, display: null },
      ...displays.flatMap((display) => [false, true].map((moderated) => ({ moderated, display }))),
      { moderated: false, display: {
        mode: 'show', version: 1, trustedContacts: 'skip', extraMetadata: 'synthetic',
      } },
    ]) {
      const item = { ...unmoderated, moderation };
      const parsed = decodeItem(item);
      expect<unknown>(parsed).toEqual(item);
      const messages = convertCodexAppServerItem(parsed, timestamp);
      expect(messages).toEqual(expectedMessages);
      expect(messages).toHaveLength(1);
      const [message] = messages;
      expect(message.type).toBe('assistant-message');
      if (message.type !== 'assistant-message') throw new Error('Expected an assistant message');
      expect(message.content).toBe(item.text);
      expect(parseChatMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
    }
    const turn = {
      id: 'synthetic-turn', status: 'completed', itemsView: 'full', error: null,
      startedAt: null, completedAt: null, durationMs: null,
      items: [{ ...unmoderated, moderation: { moderated: true, display: displays[0] } }],
    };
    expect<unknown>(parseThreadTurnsListResponse({ data: [turn], nextCursor: null, backwardsCursor: null }).data)
      .toEqual([turn]);
  });

  it('rejects malformed versioned moderation metadata', () => {
    const show = { mode: 'show', version: 1, trustedContacts: 'skip' };
    const invalidDisplays: unknown[] = [
      [], true, {}, { action: 'synthetic-action' },
      { ...show, version: undefined }, { ...show, version: null }, { ...show, version: 2 },
      { ...show, version: '1' }, { ...show, version: true }, { ...show, version: [1] },
      { ...show, mode: undefined }, { ...show, mode: 'future' }, { ...show, mode: ['show'] },
      { ...show, trustedContacts: undefined }, { ...show, trustedContacts: null },
      { ...show, trustedContacts: 'future' }, { ...show, trustedContacts: ['skip'] },
      ...[[], true, {}, { kind: 'future', subject: 'answer' },
        { kind: 'wellbeingHelpline' }, { kind: 'wellbeingHelpline', subject: null },
        { kind: 'wellbeingHelpline', subject: 'future' },
        { kind: 'wellbeingHelpline', subject: ['answer'] },
      ].map((annotation) => ({ ...show, annotation })),
      ...[undefined, null, [], {}, { kind: 'future' }, { kind: ['wellbeingPromptHelpline'] }]
        .map((replacement) => ({ mode: 'hide', version: 1, replacement })),
      ...[undefined, null, [], {}, { kind: 'future' },
        { kind: 'protection' }, { kind: 'protection', protectionType: null },
        { kind: 'protection', protectionType: 3 },
        { kind: 'cyber', trustedAccess: 'true' }, { kind: 'cyber', trustedAccess: 1 },
        { kind: ['cyber'] },
      ].map((reason) => ({ mode: 'block', version: 1, reason })),
    ];
    for (const moderation of [
      [], true, {}, { moderated: 'true' },
      ...invalidDisplays.map((display) => ({ moderated: true, display })),
    ]) {
      expect(() => decodeItem({
        type: 'agentMessage', id: 'synthetic-answer', ...itemFields.agentMessage, moderation,
      })).toThrow('moderation');
    }
  });

  it('refuses unnegotiated human-only checkpoints and unknown command approval kinds', () => {
    const kinds = approvalDefinitions.CommandExecutionApprovalKind.oneOf!.flatMap(enumValues);
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

function decodeItem(item: unknown): CodexThreadItem {
  return parseThreadItemsListResponse({
    data: [{ turnId: 'synthetic-turn', item }], nextCursor: null, backwardsCursor: null,
  }).data[0].item;
}

function enumValues(schema: SchemaNode): string[] {
  const values = schema.enum;
  if (!values || !values.every((value): value is string => typeof value === 'string')) {
    throw new Error('Expected a string enum in the bundled schema');
  }
  return values;
}
