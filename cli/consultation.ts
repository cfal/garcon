import crypto from 'node:crypto';
import type {
  AgentRunCommandRequest,
  AgentTurnCommandResponse,
  StartChatCommandRequest,
} from '@garcon/common/chat-command-contracts';
import { createClientChatId } from '@garcon/common/client-chat-id';
import type { ChatListEntry } from '@garcon/common/chat-list';
import type { ChatListResponse } from '@garcon/common/chat-list';
import type { ChatSnapshotResponse } from '@garcon/common/chat-snapshot';
import type { UpdateChatTitleRequest } from '@garcon/common/chat-title-contracts';
import type { ModelCatalogResponse } from '@garcon/common/model-catalog';
import type { RemoteSettingsSnapshot } from '@garcon/common/settings';
import { normalizeTags } from '@garcon/common/tags';
import type { CliInvocation } from './args.js';
import {
  resolveModelSelection,
  resolveHandoffSelection,
  resolveStartSelection,
  validateExplicitModes,
} from './catalog-selection.js';
import { CliError } from './errors.js';
import { GarconHttpError } from './garcon-client.js';
import type { CliOutput } from './output.js';
import {
  pollTurnReceipt,
  type ReceiptClient,
  type ReceiptPollerDependencies,
} from './receipt-poller.js';
import { writeTerminalResult } from './terminal-receipt.js';

export interface ConsultationClient extends ReceiptClient {
  getChatSnapshot(
    chatId: string,
    messageLimit: number,
    signal?: AbortSignal,
  ): Promise<ChatSnapshotResponse>;
  getModelCatalog(agentId: string, signal?: AbortSignal): Promise<ModelCatalogResponse>;
  getSettings(signal?: AbortSignal): Promise<RemoteSettingsSnapshot>;
  listChats(signal?: AbortSignal): Promise<ChatListResponse>;
  startChat(request: StartChatCommandRequest, signal?: AbortSignal): Promise<AgentTurnCommandResponse>;
  runChat(request: AgentRunCommandRequest, signal?: AbortSignal): Promise<AgentTurnCommandResponse>;
  updateChatTitle(request: UpdateChatTitleRequest, signal?: AbortSignal): Promise<void>;
}

export interface ConsultationDependencies {
  createId?: () => string;
  createChatId?: () => string;
  poller?: ReceiptPollerDependencies;
}

const START_CHAT_ID_ATTEMPTS = 3;

// The cli tag records creation provenance only. Every started chat receives it;
// resumes, send-async, steer, and stop never add it.
function startTags(additionalTags: readonly string[] | undefined): string[] {
  return normalizeTags(['cli', ...(additionalTags ?? [])]);
}

function resumeTags(additionalTags: readonly string[] | undefined): string[] | undefined {
  const tags = normalizeTags(additionalTags ?? []).filter((tag) => tag !== 'cli');
  return tags.length === 0 ? undefined : tags;
}

function requireResumeChat(sessions: readonly ChatListEntry[], chatId: string): ChatListEntry {
  const chat = sessions.find((entry) => entry?.id === chatId);
  if (!chat || typeof chat.agentId !== 'string' || chat.agentId.length === 0) {
    throw new CliError('resume admission', `chat not found: ${chatId}`, 2);
  }
  if (typeof chat.agentOwnershipEpoch !== 'string' || chat.agentOwnershipEpoch.length === 0) {
    throw new CliError('resume admission', `chat ${chatId} has no ownership epoch`, 3);
  }
  return chat;
}

async function submitStart(
  invocation: Extract<CliInvocation, { kind: 'start' }>,
  prompt: string,
  client: ConsultationClient,
  signal: AbortSignal | undefined,
  createId: () => string,
  createChatId: () => string,
): Promise<AgentTurnCommandResponse> {
  const [catalog, settings] = await Promise.all([
    client.getModelCatalog(invocation.agentId, signal),
    client.getSettings(signal),
  ]);
  const selection = resolveStartSelection(catalog, settings, {
    agentId: invocation.agentId,
    model: invocation.model,
    providerId: invocation.providerId,
    endpointId: invocation.endpointId,
    permissionMode: invocation.permissionMode,
    thinkingMode: invocation.thinkingMode,
  });
  let lastCollision: GarconHttpError | undefined;
  for (let attempt = 0; attempt < START_CHAT_ID_ATTEMPTS; attempt += 1) {
    const request: StartChatCommandRequest = {
      clientRequestId: createId(),
      clientMessageId: createId(),
      chatId: createChatId(),
      agentId: invocation.agentId,
      projectPath: invocation.cwd,
      ...selection,
      command: prompt,
      tags: startTags(invocation.additionalTags),
    };
    try {
      return await client.startChat(request, signal);
    } catch (error) {
      if (!(error instanceof GarconHttpError) || error.errorCode !== 'CHAT_ID_COLLISION') {
        throw error;
      }
      lastCollision = error;
    }
  }
  throw new CliError(
    'submission',
    `could not allocate a unique chat ID after ${START_CHAT_ID_ATTEMPTS} attempts`,
    3,
    { cause: lastCollision },
  );
}

async function submitResume(
  invocation: Extract<CliInvocation, { kind: 'resume' }>,
  prompt: string,
  client: ConsultationClient,
  signal: AbortSignal | undefined,
  createId: () => string,
): Promise<AgentTurnCommandResponse> {
  const tagsToAdd = resumeTags(invocation.additionalTags);
  const snapshot = await client.getChatSnapshot(invocation.chatId, 1, signal);
  if (snapshot.transcript.availability !== 'available') {
    throw new CliError(
      'resume admission',
      `chat ${invocation.chatId} transcript is unavailable`,
      3,
    );
  }
  const request: AgentRunCommandRequest = {
    clientRequestId: createId(),
    clientMessageId: createId(),
    chatId: invocation.chatId,
    transcriptViewId: snapshot.transcript.transcriptViewId,
    command: prompt,
    ...(tagsToAdd === undefined ? {} : { tagsToAdd }),
    permissionFallbackPolicy: 'require-explicit-bypass',
  };
  const needsCatalog = invocation.model !== undefined
    || invocation.permissionMode !== undefined
    || invocation.thinkingMode !== undefined;
  let chat: ChatListEntry | undefined;
  if (invocation.agentId !== undefined || needsCatalog) {
    chat = requireResumeChat((await client.listChats(signal)).sessions, invocation.chatId);
  }
  if (invocation.agentId !== undefined && invocation.agentId !== chat?.agentId) {
    const [catalog, settings] = await Promise.all([
      client.getModelCatalog(invocation.agentId, signal),
      client.getSettings(signal),
    ]);
    request.handoff = {
      target: resolveHandoffSelection(catalog, settings, {
        agentId: invocation.agentId,
        model: invocation.model,
        providerId: invocation.providerId,
        endpointId: invocation.endpointId,
        permissionMode: invocation.permissionMode,
        thinkingMode: invocation.thinkingMode,
      }),
      expectedAgentOwnershipEpoch: chat!.agentOwnershipEpoch,
    };
  } else {
    if (invocation.agentId !== undefined) request.expectedAgentId = invocation.agentId;
  }
  if (needsCatalog && !request.handoff) {
    const owner = chat!;
    const catalog = await client.getModelCatalog(owner.agentId, signal);
    validateExplicitModes(catalog, owner.agentId, invocation);
    if (invocation.model !== undefined) {
      Object.assign(request, resolveModelSelection(catalog, owner.agentId, {
        model: invocation.model,
        providerId: invocation.providerId,
        endpointId: invocation.endpointId,
      }));
    }
    if (invocation.permissionMode !== undefined) request.permissionMode = invocation.permissionMode;
    if (invocation.thinkingMode !== undefined) request.thinkingMode = invocation.thinkingMode;
  }
  return client.runChat(request, signal);
}

export async function runConsultation(
  invocation: CliInvocation,
  prompt: string,
  client: ConsultationClient,
  output: CliOutput,
  signal?: AbortSignal,
  dependencies: ConsultationDependencies = {},
): Promise<void> {
  const createId = dependencies.createId ?? crypto.randomUUID;
  const createChatId = dependencies.createChatId ?? createClientChatId;
  const accepted = invocation.kind === 'start'
    ? await submitStart(invocation, prompt, client, signal, createId, createChatId)
    : await submitResume(invocation, prompt, client, signal, createId);
  output.accepted(accepted);
  let titleError: unknown | undefined;
  if (invocation.title !== undefined) {
    try {
      await client.updateChatTitle({ chatId: accepted.chatId, title: invocation.title }, signal);
    } catch (error) {
      titleError = error;
    }
  }
  const receipt = await pollTurnReceipt(
    client,
    accepted.chatId,
    accepted.turnId,
    accepted.clientRequestId,
    signal,
    dependencies.poller,
  );
  writeTerminalResult(receipt, output);
  if (titleError !== undefined) throw titleError;
}
