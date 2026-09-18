import type {
  AgentStopResponse,
  AgentTurnCommandResponse,
  CommandAcceptedResponse,
  ForkChatResponse,
  ForkRunCommandResponse,
} from '@garcon/common/chat-command-contracts';
import type { AgentTurnReceipt } from '@garcon/common/agent-turn-receipt';
import type { AddChatRowResponse } from '@garcon/common/chat-row-contracts';
import type { ParentChatRef } from '@garcon/common/chat-parentage';
import type { CliError } from './errors.js';
import { GarconHttpError } from './garcon-client.js';
import type { ResumeChatAsyncResult, StopChatResult } from './chat-control.js';
import type { ForkRunResult } from './chat-fork.js';
import type {
  ConsultationResult,
  ConsultationTitleUpdate,
  StartConsultationAsyncResult,
} from './consultation.js';

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

export type CliTitleUpdate =
  | { readonly status: 'not-requested' }
  | { readonly status: 'succeeded'; readonly title: string; readonly changed: boolean }
  | { readonly status: 'failed'; readonly error: CliAutomationError };

interface StartJsonEnvelopeBase extends CliAutomationContext {
  readonly schemaVersion: typeof CLI_AUTOMATION_SCHEMA_VERSION;
  readonly receipt: CliCommandReceipt & { readonly turnId: string };
  readonly parentChat: ParentChatRef | null;
  readonly titleUpdate: CliTitleUpdate;
}

export interface StartAsyncJsonEnvelope extends StartJsonEnvelopeBase {
  readonly command: 'start-async';
}

export interface StartJsonEnvelope extends StartJsonEnvelopeBase {
  readonly command: 'start';
  readonly turnReceipt: AgentTurnReceipt;
}

interface ResumeJsonEnvelopeBase extends CliAutomationContext {
  readonly schemaVersion: typeof CLI_AUTOMATION_SCHEMA_VERSION;
  readonly receipt: CliCommandReceipt & { readonly turnId: string };
  readonly parentChat: ParentChatRef | null;
  readonly delivery: ResumeChatAsyncResult['delivery'];
}

export interface ResumeAsyncJsonEnvelope extends ResumeJsonEnvelopeBase {
  readonly command: 'resume-async';
}

export interface ResumeJsonEnvelope extends ResumeJsonEnvelopeBase {
  readonly command: 'resume';
  readonly titleUpdate: CliTitleUpdate;
  readonly turnReceipt: AgentTurnReceipt;
}

export interface AddRowJsonEnvelope extends CliAutomationContext {
  readonly schemaVersion: typeof CLI_AUTOMATION_SCHEMA_VERSION;
  readonly command: 'add-row';
  readonly response: AddChatRowResponse;
}

export interface ForkJsonEnvelope extends CliAutomationContext {
  readonly schemaVersion: typeof CLI_AUTOMATION_SCHEMA_VERSION;
  readonly command: 'fork';
  readonly sourceChatId: string;
  readonly chat: ForkChatResponse['chat'];
}

interface ForkRunJsonEnvelopeBase extends CliAutomationContext {
  readonly schemaVersion: typeof CLI_AUTOMATION_SCHEMA_VERSION;
  readonly sourceChatId: string;
  readonly receipt: CliCommandReceipt & { readonly turnId: string };
  readonly parentChat: ParentChatRef;
  readonly chat: ForkRunCommandResponse['chat'];
}

export interface ForkRunAsyncJsonEnvelope extends ForkRunJsonEnvelopeBase {
  readonly command: 'fork-async';
}

export interface ForkRunJsonEnvelope extends ForkRunJsonEnvelopeBase {
  readonly command: 'fork';
  readonly turnReceipt: AgentTurnReceipt;
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

function titleUpdate(result: ConsultationTitleUpdate): CliTitleUpdate {
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

function startEnvelopeFields(
  context: CliAutomationContext,
  result: ConsultationResult | StartConsultationAsyncResult,
): Omit<StartJsonEnvelopeBase, 'schemaVersion'> {
  return {
    ...context,
    receipt: turnReceipt(result.accepted),
    parentChat: result.accepted.parentChat ?? result.accepted.chat?.parentChat ?? null,
    titleUpdate: titleUpdate(result.titleUpdate),
  };
}

function resumeEnvelopeFields(
  context: CliAutomationContext,
  response: AgentTurnCommandResponse,
  delivery: ResumeChatAsyncResult['delivery'],
): Omit<ResumeJsonEnvelopeBase, 'schemaVersion'> {
  return {
    ...context,
    receipt: turnReceipt(response),
    parentChat: response.parentChat ?? null,
    delivery,
  };
}

export function startJsonEnvelope(
  context: CliAutomationContext,
  result: ConsultationResult,
): StartJsonEnvelope {
  return {
    schemaVersion: CLI_AUTOMATION_SCHEMA_VERSION,
    command: 'start',
    ...startEnvelopeFields(context, result),
    turnReceipt: result.turnReceipt,
  };
}

export function startAsyncJsonEnvelope(
  context: CliAutomationContext,
  result: StartConsultationAsyncResult,
): StartAsyncJsonEnvelope {
  return {
    schemaVersion: CLI_AUTOMATION_SCHEMA_VERSION,
    command: 'start-async',
    ...startEnvelopeFields(context, result),
  };
}

export function resumeAsyncJsonEnvelope(
  context: CliAutomationContext,
  result: ResumeChatAsyncResult,
): ResumeAsyncJsonEnvelope {
  return {
    schemaVersion: CLI_AUTOMATION_SCHEMA_VERSION,
    command: 'resume-async',
    ...resumeEnvelopeFields(context, result.response, result.delivery),
  };
}

export function resumeJsonEnvelope(
  context: CliAutomationContext,
  result: ConsultationResult,
): ResumeJsonEnvelope {
  return {
    schemaVersion: CLI_AUTOMATION_SCHEMA_VERSION,
    command: 'resume',
    ...resumeEnvelopeFields(context, result.accepted, 'new-turn'),
    titleUpdate: titleUpdate(result.titleUpdate),
    turnReceipt: result.turnReceipt,
  };
}

export function addRowJsonEnvelope(
  context: CliAutomationContext,
  response: AddChatRowResponse,
): AddRowJsonEnvelope {
  return {
    schemaVersion: CLI_AUTOMATION_SCHEMA_VERSION,
    command: 'add-row',
    ...context,
    response,
  };
}

export function forkJsonEnvelope(
  context: CliAutomationContext,
  sourceChatId: string,
  response: ForkChatResponse,
): ForkJsonEnvelope {
  return {
    schemaVersion: CLI_AUTOMATION_SCHEMA_VERSION,
    command: 'fork',
    ...context,
    sourceChatId,
    chat: response.chat,
  };
}

function forkRunEnvelopeFields(
  context: CliAutomationContext,
  sourceChatId: string,
  accepted: ForkRunCommandResponse,
): Omit<ForkRunJsonEnvelopeBase, 'schemaVersion'> {
  const parentChat = accepted.parentChat ?? accepted.chat.parentChat;
  if (!parentChat) throw new Error('Fork-run response is missing its parent relation');
  return {
    ...context,
    sourceChatId,
    receipt: turnReceipt(accepted),
    parentChat,
    chat: accepted.chat,
  };
}

export function forkRunAsyncJsonEnvelope(
  context: CliAutomationContext,
  sourceChatId: string,
  accepted: ForkRunCommandResponse,
): ForkRunAsyncJsonEnvelope {
  return {
    schemaVersion: CLI_AUTOMATION_SCHEMA_VERSION,
    command: 'fork-async',
    ...forkRunEnvelopeFields(context, sourceChatId, accepted),
  };
}

export function forkRunJsonEnvelope(
  context: CliAutomationContext,
  result: ForkRunResult,
): ForkRunJsonEnvelope {
  return {
    schemaVersion: CLI_AUTOMATION_SCHEMA_VERSION,
    command: 'fork',
    ...forkRunEnvelopeFields(context, result.sourceChatId, result.accepted),
    turnReceipt: result.turnReceipt,
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
