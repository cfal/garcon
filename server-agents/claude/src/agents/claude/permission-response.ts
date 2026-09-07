import type {
  AskUserQuestionDecisionResponse,
  PermissionDecisionPayload,
} from '@garcon/common/chat-command-contracts';
import { isRecord } from '@garcon/common/json';

interface ClaudePermissionInput {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  providerToolName?: string;
  providerToolInput?: Record<string, unknown>;
}

function canonicalClaudeToolName(raw: string | undefined): string {
  return (raw ?? '').trim().toLowerCase().replace(/[\s_\-]+/g, '');
}

export function isClaudeAskUserQuestionTool(raw: string | undefined): boolean {
  return canonicalClaudeToolName(raw) === 'askuserquestion';
}

function isAskUserQuestionDecisionResponse(
  response: Record<string, unknown> | undefined,
): response is AskUserQuestionDecisionResponse {
  if (!response || response.type !== 'ask-user-question-response') return false;
  return response.outcome === 'answered' || response.outcome === 'skipped';
}

function claudeAskUserQuestionControlResponse(
  pending: Pick<ClaudePermissionInput, 'toolInput' | 'toolUseId'>,
  decision: Pick<PermissionDecisionPayload, 'allow' | 'response'>,
): Record<string, unknown> | null {
  if (!isAskUserQuestionDecisionResponse(decision.response)) return null;
  if (!decision.allow || decision.response.outcome === 'skipped') {
    return {
      behavior: 'deny',
      message: decision.response.reason ?? 'User declined to answer questions',
      ...(pending.toolUseId ? { toolUseID: pending.toolUseId } : {}),
    };
  }

  const rawQuestions = Array.isArray(pending.toolInput?.questions)
    ? pending.toolInput.questions
    : [];
  const questions = rawQuestions.map((entry) => isRecord(entry) ? entry : {});
  const answers: Record<string, string> = {};
  const annotations: Record<string, { preview?: string }> = {};

  for (const answer of decision.response.answers) {
    const question = questions.find((candidate) => candidate.question === answer.questionId);
    const questionText = typeof question?.question === 'string'
      ? question.question
      : answer.questionId;
    const options = Array.isArray(question?.options)
      ? question.options.map((entry) => isRecord(entry) ? entry : {})
      : [];
    const selectedLabels = answer.selectedOptionIds.map((optionId) => {
      const option = options.find(
        (candidate) => candidate.label === optionId || candidate.id === optionId,
      );
      return typeof option?.label === 'string' ? option.label : optionId;
    });
    answers[questionText] = selectedLabels.join(', ');

    const firstSelectedOption = options.find(
      (option) => option.label === answer.selectedOptionIds[0]
        || option.id === answer.selectedOptionIds[0],
    );
    if (typeof firstSelectedOption?.preview === 'string') {
      annotations[questionText] = { preview: firstSelectedOption.preview };
    }
  }

  const updatedInput: Record<string, unknown> = {
    ...pending.toolInput,
    answers,
  };
  if (Object.keys(annotations).length > 0) {
    updatedInput.annotations = annotations;
  }

  return {
    behavior: 'allow',
    updatedInput,
    ...(pending.toolUseId ? { toolUseID: pending.toolUseId } : {}),
  };
}

// Builds the permission approval or denial response sent back to the CLI.
export function buildClaudePermissionApprovalResponse(
  pending: ClaudePermissionInput,
  decision: Pick<PermissionDecisionPayload, 'allow' | 'alwaysAllow' | 'response'>,
): Record<string, unknown> {
  const toolInput = pending.providerToolInput ?? pending.toolInput ?? {};
  const toolName = pending.providerToolName ?? pending.toolName ?? 'Unknown';
  if (isClaudeAskUserQuestionTool(toolName)) {
    const questionResponse = claudeAskUserQuestionControlResponse(
      { toolInput, toolUseId: pending.toolUseId },
      decision,
    );
    if (questionResponse) return questionResponse;
  }
  if (decision.response) return decision.response;
  if (!decision.allow) {
    return { behavior: 'deny', message: 'Denied by user' };
  }
  const response: Record<string, unknown> = {
    behavior: 'allow',
    updatedInput: toolInput,
  };
  if (decision.alwaysAllow) {
    response.updatedPermissions = [{
      type: 'addRules',
      rules: [{ toolName }],
      behavior: 'allow',
      destination: 'session',
    }];
  }
  return response;
}
