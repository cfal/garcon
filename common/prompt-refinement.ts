import { isRecord } from './json.js';
import { SNIPPET_TEMPLATE_MAX_LENGTH } from './snippets.js';
import { TICKET_LIMITS } from './tickets.js';
import { isAgentId } from './agents.js';
import { isExecutorId } from './executors.js';
import { parseChatId } from './chat-id.js';

export const PROMPT_REFINEMENT_DRAFT_MAX_LENGTH = 64_000;
export const PROMPT_REFINEMENT_OUTPUT_MAX_LENGTH = 64_000;

export type PromptRefinementTarget = 'prompt' | 'snippet-template' | 'ticket-description' | 'ticket-comment';

export type PromptRefinementSubject =
  | { kind: 'chat'; chatId: string }
  | { kind: 'selection'; agentId: string; executorId: string };

export type RefinePromptRequest = { draft: string } & (
  | { target: 'prompt'; subject: PromptRefinementSubject }
  | { target: Exclude<PromptRefinementTarget, 'prompt'> }
);

export interface RefinePromptResponse {
  success: true;
  refinedPrompt: string;
}

export function isPromptRefinementTarget(value: unknown): value is PromptRefinementTarget {
  return value === 'prompt' || value === 'snippet-template'
    || value === 'ticket-description' || value === 'ticket-comment';
}

export function promptRefinementTargetMaxLength(target: PromptRefinementTarget): number {
  if (target === 'ticket-description' || target === 'ticket-comment') return TICKET_LIMITS.bodyBytes;
  return target === 'snippet-template'
    ? SNIPPET_TEMPLATE_MAX_LENGTH
    : PROMPT_REFINEMENT_DRAFT_MAX_LENGTH;
}

export function promptRefinementTargetOutputMaxLength(target: PromptRefinementTarget): number {
  if (target === 'ticket-description' || target === 'ticket-comment') return TICKET_LIMITS.bodyBytes;
  return target === 'snippet-template'
    ? SNIPPET_TEMPLATE_MAX_LENGTH
    : PROMPT_REFINEMENT_OUTPUT_MAX_LENGTH;
}

export function normalizeRefinePromptRequest(value: unknown): RefinePromptRequest | null {
  if (
    !isRecord(value)
    || typeof value.draft !== 'string'
    || !isPromptRefinementTarget(value.target)
  ) {
    return null;
  }
  if (!value.draft.trim() || value.draft.length > promptRefinementTargetMaxLength(value.target)
    || !fitsTicketText(value.draft, value.target)) {
    return null;
  }
  if (value.target !== 'prompt') return { draft: value.draft, target: value.target };
  const subject = value.subject;
  if (!isRecord(subject)) return null;
  if (subject.kind === 'chat') {
    try {
      return { draft: value.draft, target: 'prompt', subject: { kind: 'chat', chatId: parseChatId(subject.chatId) } };
    } catch { return null; }
  }
  if (subject.kind === 'selection' && isAgentId(subject.agentId) && isExecutorId(subject.executorId)) return {
    draft: value.draft, target: 'prompt', subject: { kind: 'selection', agentId: subject.agentId, executorId: subject.executorId },
  };
  return null;
}

export function normalizeRefinePromptResponse(
  value: unknown,
  target: PromptRefinementTarget,
): RefinePromptResponse | null {
  if (!isRecord(value) || value.success !== true || typeof value.refinedPrompt !== 'string') {
    return null;
  }
  const refinedPrompt = value.refinedPrompt.trim();
  if (!refinedPrompt || refinedPrompt.length > promptRefinementTargetOutputMaxLength(target)
    || !fitsTicketText(refinedPrompt, target)) {
    return null;
  }
  return { success: true, refinedPrompt };
}

function fitsTicketText(text: string, target: PromptRefinementTarget): boolean {
  return (target !== 'ticket-description' && target !== 'ticket-comment')
    || (text.isWellFormed() && new TextEncoder().encode(text).byteLength <= TICKET_LIMITS.bodyBytes);
}
