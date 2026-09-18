import crypto from 'node:crypto';
import type { AgentTurnReceipt } from '@garcon/common/agent-turn-receipt';
import type {
  ForkChatCommandRequest,
  ForkChatResponse,
  ForkRunCommandRequest,
  ForkRunCommandResponse,
} from '@garcon/common/chat-command-contracts';
import { createClientChatId } from '@garcon/common/client-chat-id';
import type { ForkAsyncCliCommand, ForkCliCommand } from './args.js';
import { CliError } from './errors.js';
import { GarconHttpError } from './garcon-client.js';
import {
  pollTurnReceipt,
  type ReceiptClient,
  type ReceiptPollerDependencies,
} from './receipt-poller.js';

const FORK_CHAT_ID_ATTEMPTS = 3;

export interface ChatForkClient extends ReceiptClient {
  forkChat(request: ForkChatCommandRequest, signal?: AbortSignal): Promise<ForkChatResponse>;
  forkRun(request: ForkRunCommandRequest, signal?: AbortSignal): Promise<ForkRunCommandResponse>;
}

export interface ChatForkDependencies {
  readonly createId?: () => string;
  readonly createChatId?: () => string;
  readonly poller?: ReceiptPollerDependencies;
  readonly onTargetChatId?: (chatId: string) => void;
}

export interface ForkRunResult {
  readonly sourceChatId: string;
  readonly accepted: ForkRunCommandResponse;
  readonly turnReceipt: AgentTurnReceipt;
}

type ForkCommand = ForkCliCommand | ForkAsyncCliCommand;

export async function createFork(
  command: ForkCliCommand,
  client: ChatForkClient,
  signal?: AbortSignal,
  dependencies: Pick<ChatForkDependencies, 'createChatId' | 'onTargetChatId'> = {},
): Promise<ForkChatResponse> {
  const createChatId = dependencies.createChatId ?? createClientChatId;
  let lastCollision: GarconHttpError | undefined;
  for (let attempt = 0; attempt < FORK_CHAT_ID_ATTEMPTS; attempt += 1) {
    const request: ForkChatCommandRequest = {
      sourceChatId: command.sourceChatId,
      chatId: createChatId(),
      ...(command.allowHandoffFork ? { allowHandoffFork: true } : {}),
    };
    dependencies.onTargetChatId?.(request.chatId);
    try {
      return await client.forkChat(request, signal);
    } catch (error) {
      if (!(error instanceof GarconHttpError) || error.errorCode !== 'CHAT_ID_COLLISION') {
        throw error;
      }
      lastCollision = error;
    }
  }
  throw new CliError(
    'submission',
    `could not allocate a unique fork chat ID after ${FORK_CHAT_ID_ATTEMPTS} attempts`,
    3,
    { cause: lastCollision },
  );
}

export async function submitForkRun(
  command: ForkCommand,
  content: string,
  client: ChatForkClient,
  signal?: AbortSignal,
  dependencies: Pick<
    ChatForkDependencies,
    'createId' | 'createChatId' | 'onTargetChatId'
  > = {},
): Promise<ForkRunCommandResponse> {
  if (content.trim().length === 0) {
    throw new CliError('arguments', 'the fork message must not be empty', 2);
  }
  const createId = dependencies.createId ?? crypto.randomUUID;
  const createChatId = dependencies.createChatId ?? createClientChatId;
  let lastCollision: GarconHttpError | undefined;
  for (let attempt = 0; attempt < FORK_CHAT_ID_ATTEMPTS; attempt += 1) {
    const request: ForkRunCommandRequest = {
      clientRequestId: createId(),
      clientMessageId: createId(),
      sourceChatId: command.sourceChatId,
      chatId: createChatId(),
      command: content,
      ...(command.allowHandoffFork ? { allowHandoffFork: true } : {}),
    };
    dependencies.onTargetChatId?.(request.chatId);
    try {
      return await client.forkRun(request, signal);
    } catch (error) {
      if (!(error instanceof GarconHttpError) || error.errorCode !== 'CHAT_ID_COLLISION') {
        throw error;
      }
      lastCollision = error;
    }
  }
  throw new CliError(
    'submission',
    `could not allocate a unique fork chat ID after ${FORK_CHAT_ID_ATTEMPTS} attempts`,
    3,
    { cause: lastCollision },
  );
}

export async function settleForkRun(
  sourceChatId: string,
  accepted: ForkRunCommandResponse,
  client: ChatForkClient,
  signal?: AbortSignal,
  dependencies: Pick<ChatForkDependencies, 'poller'> = {},
): Promise<ForkRunResult> {
  const turnReceipt = await pollTurnReceipt(
    client,
    accepted.chatId,
    accepted.turnId,
    accepted.clientRequestId,
    signal,
    dependencies.poller,
  );
  return { sourceChatId, accepted, turnReceipt };
}
