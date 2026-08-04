import crypto from 'node:crypto';
import type {
  AgentRunCommandRequest,
  AgentStopCommandRequest,
  AgentStopResponse,
  AgentTurnCommandResponse,
  SteerCommandRequest,
  SteerCommandResponse,
} from '@garcon/common/chat-command-contracts';
import { abortableDelay } from './abortable-delay.js';
import { CliError } from './errors.js';
import { GarconHttpError } from './garcon-client.js';
import type { CliOutput } from './output.js';

const MAX_CONTROL_DISPATCH_ATTEMPTS = 3;
const CONTROL_STATE_RETRY_DELAY_MS = 50;

export interface ChatControlClient {
  runChat(
    request: AgentRunCommandRequest,
    signal?: AbortSignal,
  ): Promise<AgentTurnCommandResponse>;
  steerChat(
    request: SteerCommandRequest,
    signal?: AbortSignal,
  ): Promise<SteerCommandResponse>;
  stopChat(
    request: AgentStopCommandRequest,
    signal?: AbortSignal,
  ): Promise<AgentStopResponse>;
}

export interface ChatControlDependencies {
  createId?: () => string;
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

function hasDefinitiveConflictCode(error: unknown, code: string): boolean {
  // Route switches require the definitive HTTP 409 conflict plus the exact code;
  // an identical code on another status must propagate unchanged.
  return error instanceof GarconHttpError
    && error.status === 409
    && error.errorCode === code;
}

// Only these two definitive 409 rejections prove that the steering identity did
// not deliver the input, so the chat may now accept a normal run. Provider
// delivery failures and capability rejections never authorize a route switch.
function isSafeSteerStateFlip(error: unknown): boolean {
  return hasDefinitiveConflictCode(error, 'STEER_TURN_UNAVAILABLE')
    || hasDefinitiveConflictCode(error, 'STEER_TURN_CHANGED');
}

// Alternates between the run and steer endpoints for at most three logical
// dispatch attempts, switching routes only after a server response that proves
// the message was not delivered. The normal run request is allocated once and
// reused byte-for-byte when returning to /run, because the server's pre-schedule
// failure replay path resets an exact failed run identity.
export async function sendChatAsync(
  input: { chatId: string; content: string; allowSteer: boolean },
  client: ChatControlClient,
  output: CliOutput,
  signal?: AbortSignal,
  dependencies: ChatControlDependencies = {},
): Promise<void> {
  const createId = dependencies.createId ?? crypto.randomUUID;
  const delay = dependencies.delay ?? abortableDelay;
  const runRequest: AgentRunCommandRequest = {
    clientRequestId: createId(),
    clientMessageId: createId(),
    chatId: input.chatId,
    command: input.content,
  };
  let operation: 'run' | 'steer' = 'run';
  let lastStateFlip: GarconHttpError | undefined;

  for (let attempt = 0; attempt < MAX_CONTROL_DISPATCH_ATTEMPTS; attempt += 1) {
    try {
      if (operation === 'run') {
        const response = await client.runChat(runRequest, signal);
        output.sent(response.chatId, 'new-turn', response.turnId);
        return;
      }

      // A steer attempt gets a fresh identity; a later logical steer must never
      // reuse the identity of a definitively rejected prior steer.
      const request: SteerCommandRequest = {
        clientRequestId: createId(),
        clientMessageId: createId(),
        chatId: input.chatId,
        content: input.content,
      };
      const response = await client.steerChat(request, signal);
      output.sent(response.chatId, 'steer', response.turnId);
      return;
    } catch (error) {
      if (operation === 'run') {
        if (!hasDefinitiveConflictCode(error, 'SESSION_BUSY')) throw error;
        if (!input.allowSteer) {
          throw new CliError(
            'submission',
            `chat ${input.chatId} is busy; retry later or pass --allow-steer`,
            3,
            { cause: error },
          );
        }
        lastStateFlip = error as GarconHttpError;
        operation = 'steer';
      } else {
        if (!isSafeSteerStateFlip(error)) throw error;
        lastStateFlip = error as GarconHttpError;
        operation = 'run';
      }

      if (attempt === MAX_CONTROL_DISPATCH_ATTEMPTS - 1) break;
      await delay(CONTROL_STATE_RETRY_DELAY_MS, signal);
    }
  }

  throw new CliError(
    'submission',
    `chat ${input.chatId} changed execution state repeatedly; the message was not sent after 3 attempts`
      + (lastStateFlip?.errorCode ? ` (last result: ${lastStateFlip.errorCode})` : ''),
    3,
    { cause: lastStateFlip },
  );
}

export async function stopChat(
  chatId: string,
  client: ChatControlClient,
  output: CliOutput,
  signal?: AbortSignal,
  dependencies: Pick<ChatControlDependencies, 'createId'> = {},
): Promise<void> {
  const response = await client.stopChat({
    clientRequestId: (dependencies.createId ?? crypto.randomUUID)(),
    chatId,
  }, signal);
  if (response.outcome === 'failed') {
    throw new CliError('submission', `Garcon could not stop chat ${chatId}`, 3);
  }
  output.stopped(chatId, response.outcome);
}