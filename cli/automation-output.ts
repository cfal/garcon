import type {
  AgentStopResponse,
  AgentTurnCommandResponse,
  CommandAcceptedResponse,
} from '@garcon/common/chat-command-contracts';
import type { ParentChatRef } from '@garcon/common/chat-parentage';
import type { CliError } from './errors.js';
import { GarconHttpError } from './garcon-client.js';
import type { ResumeChatAsyncResult, StopChatResult } from './chat-control.js';
import type { StartConsultationAsyncResult } from './consultation.js';

export const CLI_AUTOMATION_SCHEMA_VERSION = 1 as const;

export interface CliAutomationContext {
  readonly workspace: string;
  readonly serverInstanceId: string;
}

export interface CliCommandReceipt {
  readonly commandType: string;
  readonly clientRequestId: string;
  readonly chatId: string;
  readonly turnId?: string;
  readonly status: CommandAcceptedResponse['status'];
  readonly acceptedAt: string;
}

export interface CliAutomationError {
  readonly phase: CliError['phase'] | 'submission';
  readonly errorCode: string | null;
  readonly message: string;
}

type StartTitleUpdate =
  | { readonly status: 'not-requested' }
  | { readonly status: 'succeeded'; readonly title: string; readonly changed: boolean }
  | { readonly status: 'failed'; readonly error: CliAutomationError };

export interface StartAsyncJsonEnvelope extends CliAutomationContext {
  readonly schemaVersion: typeof CLI_AUTOMATION_SCHEMA_VERSION;
  readonly command: 'start-async';
  readonly receipt: CliCommandReceipt & { readonly turnId: string };
  readonly parentChat: ParentChatRef | null;
  readonly titleUpdate: StartTitleUpdate;
}

export interface ResumeAsyncJsonEnvelope extends CliAutomationContext {
  readonly schemaVersion: typeof CLI_AUTOMATION_SCHEMA_VERSION;
  readonly command: 'resume-async';
  readonly receipt: CliCommandReceipt & { readonly turnId: string };
  readonly parentChat: ParentChatRef | null;
  readonly delivery: ResumeChatAsyncResult['delivery'];
}

export interface StopJsonEnvelope extends CliAutomationContext {
  readonly schemaVersion: typeof CLI_AUTOMATION_SCHEMA_VERSION;
  readonly command: 'stop';
  readonly receipt: CliCommandReceipt;
  readonly parentChat: ParentChatRef | null;
  readonly outcome: Exclude<AgentStopResponse['outcome'], 'failed'>;
  readonly control: AgentStopResponse['control'];
}

function turnReceipt(response: AgentTurnCommandResponse): CliCommandReceipt & { turnId: string } {
  return {
    commandType: response.commandType,
    clientRequestId: response.clientRequestId,
    chatId: response.chatId,
    turnId: response.turnId,
    status: response.status,
    acceptedAt: response.acceptedAt,
  };
}

function commandReceipt(response: AgentStopResponse): CliCommandReceipt {
  if (!response.chatId) throw new Error('Stop response is missing its chat identity');
  return {
    commandType: response.commandType,
    clientRequestId: response.clientRequestId,
    chatId: response.chatId,
    status: response.status,
    acceptedAt: response.acceptedAt,
  };
}

function automationError(error: unknown): CliAutomationError {
  const value = error as Partial<CliError>;
  return {
    phase: typeof value?.phase === 'string' ? value.phase as CliError['phase'] : 'submission',
    errorCode: error instanceof GarconHttpError ? error.errorCode : null,
    message: error instanceof Error ? error.message : String(error),
  };
}

function titleUpdate(result: StartConsultationAsyncResult['titleUpdate']): StartTitleUpdate {
  if (result.status === 'not-requested') return result;
  if (result.status === 'failed') {
    return { status: 'failed', error: automationError(result.error) };
  }
  return {
    status: 'succeeded',
    title: result.response.title,
    changed: result.response.changed,
  };
}

export function startAsyncJsonEnvelope(
  context: CliAutomationContext,
  result: StartConsultationAsyncResult,
): StartAsyncJsonEnvelope {
  return {
    schemaVersion: CLI_AUTOMATION_SCHEMA_VERSION,
    command: 'start-async',
    ...context,
    receipt: turnReceipt(result.accepted),
    parentChat: result.accepted.parentChat ?? result.accepted.chat?.parentChat ?? null,
    titleUpdate: titleUpdate(result.titleUpdate),
  };
}

export function resumeAsyncJsonEnvelope(
  context: CliAutomationContext,
  result: ResumeChatAsyncResult,
): ResumeAsyncJsonEnvelope {
  return {
    schemaVersion: CLI_AUTOMATION_SCHEMA_VERSION,
    command: 'resume-async',
    ...context,
    receipt: turnReceipt(result.response),
    parentChat: result.response.parentChat ?? null,
    delivery: result.delivery,
  };
}

export function stopJsonEnvelope(
  context: CliAutomationContext,
  result: StopChatResult,
): StopJsonEnvelope {
  return {
    schemaVersion: CLI_AUTOMATION_SCHEMA_VERSION,
    command: 'stop',
    ...context,
    receipt: commandReceipt(result.response),
    parentChat: result.response.parentChat ?? null,
    outcome: result.response.outcome,
    control: result.response.control,
  };
}

export function titleUpdateFailure(result: StartConsultationAsyncResult): unknown | undefined {
  return result.titleUpdate.status === 'failed' ? result.titleUpdate.error : undefined;
}
