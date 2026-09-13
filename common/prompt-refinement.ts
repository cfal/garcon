import { isRecord } from './json.js';
import { SNIPPET_TEMPLATE_MAX_LENGTH } from './snippets.js';
import { ISSUE_LIMITS } from './issues.js';

export const PROMPT_REFINEMENT_DRAFT_MAX_LENGTH = 64_000;
export const PROMPT_REFINEMENT_OUTPUT_MAX_LENGTH = 64_000;

export type PromptRefinementTarget = 'prompt' | 'snippet-template' | 'issue-description' | 'issue-comment';

export interface RefinePromptRequest {
  draft: string;
  target: PromptRefinementTarget;
}

export interface RefinePromptResponse {
  success: true;
  refinedPrompt: string;
}

export function isPromptRefinementTarget(value: unknown): value is PromptRefinementTarget {
  return value === 'prompt' || value === 'snippet-template'
    || value === 'issue-description' || value === 'issue-comment';
}

export function promptRefinementTargetMaxLength(target: PromptRefinementTarget): number {
  if (target === 'issue-description' || target === 'issue-comment') return ISSUE_LIMITS.bodyBytes;
  return target === 'snippet-template'
    ? SNIPPET_TEMPLATE_MAX_LENGTH
    : PROMPT_REFINEMENT_DRAFT_MAX_LENGTH;
}

export function promptRefinementTargetOutputMaxLength(target: PromptRefinementTarget): number {
  if (target === 'issue-description' || target === 'issue-comment') return ISSUE_LIMITS.bodyBytes;
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
    || !fitsIssueText(value.draft, value.target)) {
    return null;
  }
  return { draft: value.draft, target: value.target };
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
    || !fitsIssueText(refinedPrompt, target)) {
    return null;
  }
  return { success: true, refinedPrompt };
}

function fitsIssueText(text: string, target: PromptRefinementTarget): boolean {
  return (target !== 'issue-description' && target !== 'issue-comment')
    || (text.isWellFormed() && new TextEncoder().encode(text).byteLength <= ISSUE_LIMITS.bodyBytes);
}
