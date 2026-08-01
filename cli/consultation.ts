import crypto from 'node:crypto';
import type { AgentTurnReceipt } from '@garcon/common/agent-turn-receipt';
import type {
  AgentRunCommandRequest,
  AgentTurnCommandResponse,
  StartChatCommandRequest,
} from '@garcon/common/chat-command-contracts';
import { createClientChatId } from '@garcon/common/client-chat-id';
import type { ChatListEntry } from '@garcon/common/chat-list';
import type { ChatListResponse } from '@garcon/common/chat-list';
import type { ModelCatalogResponse } from '@garcon/common/model-catalog';
import type { RemoteSettingsSnapshot } from '@garcon/common/settings';
import type { CliInvocation } from './args.js';
import {
  resolveModelSelection,
  resolveStartSelection,
  validateExplicitModes,
} from './catalog-selection.js';
import { CliError } from './errors.js';
import type { CliOutput } from './output.js';
import {
  pollTurnReceipt,
  type ReceiptClient,
  type ReceiptPollerDependencies,
} from './receipt-poller.js';

export interface ConsultationClient extends ReceiptClient {
  getModelCatalog(agentId: string, signal?: AbortSignal): Promise<ModelCatalogResponse>;
  getSettings(signal?: AbortSignal): Promise<RemoteSettingsSnapshot>;
  listChats(signal?: AbortSignal): Promise<ChatListResponse>;
  startChat(request: StartChatCommandRequest, signal?: AbortSignal): Promise<AgentTurnCommandResponse>;
  runChat(request: AgentRunCommandRequest, signal?: AbortSignal): Promise<AgentTurnCommandResponse>;
}

export interface ConsultationDependencies {
  createId?: () => string;
  createChatId?: () => string;
  poller?: ReceiptPollerDependencies;
}

function terminalResult(receipt: AgentTurnReceipt, output: CliOutput): void {
  if (receipt.state === 'completed') {
    if (receipt.output.availability === 'unavailable') {
      throw new CliError(
        'receipt polling',
        'the turn completed, but its result is too large for the CLI receipt; view it in Garcon',
        3,
      );
    }
    output.completed(receipt.output.assistantMessages);
    return;
  }
  if (receipt.state === 'failed') {
    throw new CliError('receipt polling', `agent turn failed: ${receipt.error}`, 1);
  }
  if (receipt.state === 'interrupted') {
    const reason = receipt.reason === 'chat-deleted' ? 'the chat was deleted' : 'the turn was stopped';
    throw new CliError('receipt polling', `agent turn interrupted: ${reason}`, 4);
  }
  throw new CliError('receipt polling', 'turn receipt unexpectedly remained pending', 3);
}

function requireResumeChat(sessions: readonly ChatListEntry[], chatId: string): ChatListEntry {
  const chat = sessions.find((entry) => entry?.id === chatId);
  if (!chat || typeof chat.agentId !== 'string' || chat.agentId.length === 0) {
    throw new CliError('resume admission', `chat not found: ${chatId}`, 2);
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
  const request: StartChatCommandRequest = {
    clientRequestId: createId(),
    clientMessageId: createId(),
    chatId: createChatId(),
    agentId: invocation.agentId,
    projectPath: invocation.cwd,
    ...selection,
    command: prompt,
    tags: ['cli'],
  };
  return client.startChat(request, signal);
}

async function submitResume(
  invocation: Extract<CliInvocation, { kind: 'resume' }>,
  prompt: string,
  client: ConsultationClient,
  signal: AbortSignal | undefined,
  createId: () => string,
): Promise<AgentTurnCommandResponse> {
  const request: AgentRunCommandRequest = {
    clientRequestId: createId(),
    clientMessageId: createId(),
    chatId: invocation.chatId,
    command: prompt,
    ...(invocation.agentId === undefined ? {} : { expectedAgentId: invocation.agentId }),
    tagsToAdd: ['cli'],
    permissionFallbackPolicy: 'require-explicit-bypass',
  };
  const needsCatalog = invocation.model !== undefined
    || invocation.permissionMode !== undefined
    || invocation.thinkingMode !== undefined;
  if (needsCatalog) {
    const chats = await client.listChats(signal);
    const chat = requireResumeChat(chats.sessions, invocation.chatId);
    if (invocation.agentId !== undefined && invocation.agentId !== chat.agentId) {
      throw new CliError(
        'resume admission',
        `chat ${invocation.chatId} belongs to ${chat.agentId}, not ${invocation.agentId}`,
        2,
      );
    }
    const catalog = await client.getModelCatalog(chat.agentId, signal);
    validateExplicitModes(catalog, chat.agentId, invocation);
    if (invocation.model !== undefined) {
      Object.assign(request, resolveModelSelection(catalog, chat.agentId, {
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
  output.accepted(accepted.chatId);
  const receipt = await pollTurnReceipt(
    client,
    accepted.chatId,
    accepted.turnId,
    signal,
    dependencies.poller,
  );
  terminalResult(receipt, output);
}
