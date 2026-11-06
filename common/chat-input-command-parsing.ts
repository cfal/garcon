import { asyncQuestionReplyText, parseAsyncQuestionReply, type AsyncQuestionReply } from './async-user-questions.js';
import { parseUserMessagePresentation, type UserMessagePresentation } from './chat-types.js';
import { CommandRequestValidationError, optionalNonEmptyString } from './command-request-validation.js';

export function parseCommandQuestionReply(body: Record<string, unknown>, contentField: string): AsyncQuestionReply | undefined {
  let reply: AsyncQuestionReply | undefined;
  try {
    reply = parseAsyncQuestionReply(body.questionReply);
  } catch {
    throw new CommandRequestValidationError('Invalid async question reply');
  }
  if (!reply) return undefined;
  if (!reply.source || reply.source.chatId !== body.chatId
    || reply.source.transcriptViewId !== body.transcriptViewId
    || asyncQuestionReplyText(reply) !== body[contentField]
    || !optionalNonEmptyString(body, 'expectedAgentId')
    || !optionalNonEmptyString(body, 'expectedAgentOwnershipEpoch')
    || body.whenTurnUnavailable === 'queue' || body.handoff !== undefined
    || body.userMessagePresentation !== undefined
    || (Array.isArray(body.images) && body.images.length > 0)) {
    throw new CommandRequestValidationError('Question replies require their source view, ownership, and exact text without queueing or handoff');
  }
  return reply;
}

export function rejectQuestionReply(body: Record<string, unknown>): void {
  if (body.questionReply !== undefined) {
    throw new CommandRequestValidationError('Question replies require direct run or steer admission');
  }
}

export function parseCommandUserMessagePresentation(value: unknown): UserMessagePresentation | undefined {
  try {
    return parseUserMessagePresentation(value);
  } catch (error) {
    throw new CommandRequestValidationError(
      error instanceof Error ? error.message : 'userMessagePresentation is invalid',
    );
  }
}
