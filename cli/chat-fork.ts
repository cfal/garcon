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

async function submitWithUniqueTargetChatId<T>(
  createChatId: () => string,
  onTargetChatId: ((chatId: string) => void) | undefined,
  submit: (chatId: string) => Promise<T>,
): Promise<T> {
  let lastCollision: GarconHttpError | undefined;
  for (let attempt = 0; attempt < FORK_CHAT_ID_ATTEMPTS; attempt += 1) {
    const chatId = createChatId();
    onTargetChatId?.(chatId);
    try {
      return await submit(chatId);
    } catch (error) {
      if (!isTargetChatIdCollision(error, chatId)) {
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

function isTargetChatIdCollision(error: unknown, chatId: string): error is GarconHttpError {
  return error instanceof GarconHttpError
    && error.status === 409
    && error.errorCode === 'IDEMPOTENCY_CONFLICT'
    && error.responseError === `Session already exists: ${chatId}`;
}

export async function createFork(
  command: ForkCliCommand,
  client: ChatForkClient,
  signal?: AbortSignal,
  dependencies: Pick<ChatForkDependencies, 'createChatId' | 'onTargetChatId'> = {},
): Promise<ForkChatResponse> {
  const createChatId = dependencies.createChatId ?? createClientChatId;
  return submitWithUniqueTargetChatId(
    createChatId,
    dependencies.onTargetChatId,
    (chatId) => client.forkChat({
      sourceChatId: command.sourceChatId,
      chatId,
      ...(command.allowHandoffFork ? { allowHandoffFork: true } : {}),
    }, signal),
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
  return submitWithUniqueTargetChatId(
    createChatId,
    dependencies.onTargetChatId,
    (chatId) => client.forkRun({
      clientRequestId: createId(),
      clientMessageId: createId(),
      sourceChatId: command.sourceChatId,
      chatId,
      command: content,
      ...(command.allowHandoffFork ? { allowHandoffFork: true } : {}),
    }, signal),
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
