import crypto from 'node:crypto';
import type {
  CommandAcceptedResponse,
  PermissionDecisionCommandRequest,
} from '@garcon/common/chat-command-contracts';
import type {
  PermissionAnswerCliCommand,
  PermissionDecisionCliCommand,
} from './args.js';
import { argumentError } from './errors.js';
import { GarconHttpError } from './garcon-client.js';
import type { CliOutput } from './output.js';

export interface PermissionDecisionClient {
  decidePermission(
    request: PermissionDecisionCommandRequest,
    signal?: AbortSignal,
  ): Promise<CommandAcceptedResponse>;
}

type PermissionCliCommand = PermissionDecisionCliCommand | PermissionAnswerCliCommand;

export function permissionDecisionClientRequestId(
  command: Pick<
    PermissionDecisionCliCommand,
    'serverInstanceId' | 'chatId' | 'runId' | 'permissionOccurrenceId'
  >,
): string {
  const digest = crypto.createHash('sha256').update(JSON.stringify([
    command.serverInstanceId,
    command.chatId,
    command.runId,
    command.permissionOccurrenceId,
  ])).digest('hex');
  return `permission-v1:${digest}`;
}

function permissionControl(
  command: PermissionCliCommand,
): PermissionDecisionCommandRequest['control'] {
  return {
    serverInstanceId: command.serverInstanceId,
    chatId: command.chatId,
    runId: command.runId,
    permissionOccurrenceId: command.permissionOccurrenceId,
  };
}

function formatPermissionReceipt(
  command: PermissionCliCommand,
  response: CommandAcceptedResponse,
  detail: string,
): string {
  if (command.json) return JSON.stringify(response, null, 2);
  return [
    `chat id: ${response.chatId}`,
    `permission occurrence: ${command.permissionOccurrenceId}`,
    detail,
    `status: ${response.status}`,
  ].join('\n');
}

export async function runPermissionDecision(
  command: PermissionDecisionCliCommand,
  client: PermissionDecisionClient,
  output: CliOutput,
  signal?: AbortSignal,
): Promise<void> {
  const response = await client.decidePermission({
    clientRequestId: permissionDecisionClientRequestId(command),
    chatId: command.chatId,
    permissionOccurrenceId: command.permissionOccurrenceId,
    allow: command.allow,
    alwaysAllow: false,
    control: permissionControl(command),
  }, signal);
  output.result(formatPermissionReceipt(
    command,
    response,
    `decision: ${command.allow ? 'allow' : 'deny'}`,
  ));
}

export async function runPermissionAnswer(
  command: PermissionAnswerCliCommand,
  client: PermissionDecisionClient,
  output: CliOutput,
  signal?: AbortSignal,
): Promise<void> {
  let response: CommandAcceptedResponse;
  try {
    response = await client.decidePermission({
      clientRequestId: permissionDecisionClientRequestId(command),
      chatId: command.chatId,
      permissionOccurrenceId: command.permissionOccurrenceId,
      allow: true,
      alwaysAllow: false,
      response: command.response,
      control: permissionControl(command),
    }, signal);
  } catch (error) {
    if (
      error instanceof GarconHttpError
      && error.status === 400
      && error.errorCode === 'VALIDATION_FAILED'
    ) {
      throw argumentError(error.message, { cause: error });
    }
    throw error;
  }
  output.result(formatPermissionReceipt(
    command,
    response,
    `answers: ${command.response.answers.length}`,
  ));
}
