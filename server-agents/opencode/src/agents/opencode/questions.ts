import crypto from 'node:crypto';
import type {
  AskUserQuestionDecisionResponse,
  PermissionDecisionPayload,
} from '@garcon/common/chat-command-contracts';
import type { AskUserQuestionPrompt } from '@garcon/common/chat-types';
import { isRecord } from '@garcon/common/json';
import type {
  AgentRuntimeEvent,
  AgentRuntimeOperation,
} from '@garcon/server-agent-common/execution/runtime-events';
import type { AgentLogger } from '@garcon/server-agent-interface';
import type { OpenCodeOperationRoute } from './operation-routes.js';
import {
  throwOpenCodeResultError,
  withOpenCodeRequestScope,
  type OpenCodeRequestScope,
} from './sdk-result.js';
import type { SSEEvent } from './sse-events.js';
import { convertOpenCodeQuestionToolUse } from './tool-use-converter.js';

export interface OpenCodeQuestionRequest {
  readonly requestId: string;
  readonly toolCallId: string;
  readonly questions: unknown;
}

export type OpenCodeQuestionDecision =
  | { readonly kind: 'reply'; readonly answers: string[][] }
  | { readonly kind: 'reject' };

interface PendingOpenCodeQuestion {
  readonly permissionOccurrenceId: string;
  readonly originalRequestId: string;
  readonly agentSessionId: string;
  readonly directory?: string;
  readonly operation: AgentRuntimeOperation;
  readonly questions: AskUserQuestionPrompt[];
}

export interface OpenCodeQuestionControllerOptions {
  readonly logger: AgentLogger;
  readonly publish: (
    agentSessionId: string,
    operation: AgentRuntimeOperation,
    event: AgentRuntimeEvent,
  ) => void;
  readonly getClient: () => Promise<any>;
  readonly runScopedRequest: <T>(
    label: string,
    scope: OpenCodeRequestScope,
    operation: (signal: AbortSignal, scope: OpenCodeRequestScope) => Promise<T>,
  ) => Promise<T>;
}

export function extractOpenCodeQuestionRequest(event: SSEEvent): OpenCodeQuestionRequest | null {
  if (event.type !== 'question.asked') return null;
  const properties = event.properties ?? {};
  const tool = isRecord(properties.tool) ? properties.tool : null;
  if (
    typeof properties.id !== 'string'
    || !properties.id
    || !Array.isArray(properties.questions)
    || typeof tool?.callID !== 'string'
    || !tool.callID
  ) return null;
  return {
    requestId: properties.id,
    toolCallId: tool.callID,
    questions: properties.questions,
  };
}

function parseQuestionResponse(
  response: Record<string, unknown> | undefined,
): AskUserQuestionDecisionResponse | null {
  if (!response || response.type !== 'ask-user-question-response') return null;
  if (response.outcome === 'skipped') {
    if (response.reason !== undefined && typeof response.reason !== 'string') return null;
    return response as unknown as AskUserQuestionDecisionResponse;
  }
  if (response.outcome !== 'answered' || !Array.isArray(response.answers)) return null;
  for (const answer of response.answers) {
    if (
      !isRecord(answer)
      || typeof answer.questionId !== 'string'
      || !Array.isArray(answer.selectedOptionIds)
      || !answer.selectedOptionIds.every((optionId) => typeof optionId === 'string')
    ) return null;
  }
  return response as unknown as AskUserQuestionDecisionResponse;
}

export function mapOpenCodeQuestionDecision(
  questions: readonly AskUserQuestionPrompt[],
  decision: Pick<PermissionDecisionPayload, 'allow' | 'response'>,
): OpenCodeQuestionDecision {
  const response = parseQuestionResponse(decision.response);
  if (!decision.allow || response?.outcome === 'skipped') return { kind: 'reject' };
  if (!response || response.outcome !== 'answered') {
    throw new Error('OpenCode question decision is missing an answered response');
  }

  const answersByQuestion = new Map(
    response.answers.map((answer) => [answer.questionId, answer.selectedOptionIds]),
  );
  return {
    kind: 'reply',
    answers: questions.map((question) => {
      const optionLabels = new Map(question.options.map((option) => [option.id, option.label]));
      return (answersByQuestion.get(question.id) ?? [])
        .map((optionId) => optionLabels.get(optionId) ?? optionId)
        .filter(Boolean);
    }),
  };
}

export class OpenCodeQuestionController {
  readonly #pending = new Set<PendingOpenCodeQuestion>();

  constructor(private readonly options: OpenCodeQuestionControllerOptions) {}

  handle(event: SSEEvent, sessionId: string, route: OpenCodeOperationRoute): void {
    const toolMessageId = event.properties?.tool?.messageID;
    if (
      typeof toolMessageId !== 'string'
      || !route.turn.assistantMessageIds.has(toolMessageId)
    ) {
      this.options.logger.warn('Ignoring an OpenCode question for a message outside its turn', {
        agentSessionId: sessionId,
        eventId: event.id ?? null,
      });
      return;
    }
    const request = extractOpenCodeQuestionRequest(event);
    const requestedTool = request
      ? convertOpenCodeQuestionToolUse(
          new Date().toISOString(),
          request.toolCallId,
          request.questions,
        )
      : null;
    if (!request || !requestedTool) {
      this.options.logger.warn('Ignoring a malformed OpenCode question request', {
        agentSessionId: sessionId,
        eventId: event.id ?? null,
      });
      return;
    }
    const permissionOccurrenceId = crypto.randomUUID();
    const pending: PendingOpenCodeQuestion = {
      permissionOccurrenceId,
      originalRequestId: request.requestId,
      agentSessionId: sessionId,
      directory: route.directory,
      operation: route.turn.operation,
      questions: requestedTool.questions,
    };
    this.#pending.add(pending);
    this.options.publish(sessionId, route.turn.operation, {
      type: 'permission',
      runId: route.turn.operation.runId,
      lifecycle: {
        kind: 'requested',
        permissionOccurrenceId,
        requestedTool,
        options: [],
      },
      decision: Object.freeze({
        permissionOccurrenceId,
        respond: (decision: PermissionDecisionPayload) => this.#resolve(pending, decision),
      }),
    });
  }

  cancelForSession(
    agentSessionId: string,
    reason: 'cancelled' | 'session-complete' | 'aborted',
  ): void {
    for (const pending of [...this.#pending]) {
      if (pending.agentSessionId !== agentSessionId) continue;
      this.#pending.delete(pending);
      this.options.publish(agentSessionId, pending.operation, {
        type: 'permission',
        runId: pending.operation.runId,
        lifecycle: {
          kind: 'cancelled',
          permissionOccurrenceId: pending.permissionOccurrenceId,
          reason,
        },
      });
    }
  }

  clear(): void {
    this.#pending.clear();
  }

  async #resolve(
    pending: PendingOpenCodeQuestion,
    decision: PermissionDecisionPayload,
  ): Promise<void> {
    if (!this.#pending.has(pending)) {
      throw new Error('OpenCode question occurrence is no longer pending');
    }
    const response = mapOpenCodeQuestionDecision(pending.questions, decision);
    const client = await this.options.getClient();
    const result = await this.options.runScopedRequest(
      response.kind === 'reply' ? 'OpenCode question reply' : 'OpenCode question reject',
      { directory: pending.directory },
      (signal, requestScope) => response.kind === 'reply'
        ? client.question.reply(
            withOpenCodeRequestScope({
              requestID: pending.originalRequestId,
              answers: response.answers,
            }, requestScope),
            { signal },
          )
        : client.question.reject(
            withOpenCodeRequestScope({ requestID: pending.originalRequestId }, requestScope),
            { signal },
          ),
    );
    throwOpenCodeResultError(result, response.kind === 'reply'
      ? 'OpenCode question reply failed'
      : 'OpenCode question reject failed');
    this.#pending.delete(pending);
  }
}
