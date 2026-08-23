import { isRecord } from './json.js';
import { SNIPPET_TEMPLATE_MAX_LENGTH } from './snippets.js';

export const PROMPT_REFINEMENT_DRAFT_MAX_LENGTH = 64_000;
export const PROMPT_REFINEMENT_OUTPUT_MAX_LENGTH = 64_000;

export type PromptRefinementTarget = 'prompt' | 'snippet-template';

export interface RefinePromptRequest {
  draft: string;
  target: PromptRefinementTarget;
}

export interface RefinePromptResponse {
  success: true;
  refinedPrompt: string;
}

export function isPromptRefinementTarget(value: unknown): value is PromptRefinementTarget {
  return value === 'prompt' || value === 'snippet-template';
}

export function promptRefinementTargetMaxLength(target: PromptRefinementTarget): number {
  return target === 'snippet-template'
    ? SNIPPET_TEMPLATE_MAX_LENGTH
    : PROMPT_REFINEMENT_DRAFT_MAX_LENGTH;
}

export function normalizeRefinePromptRequest(value: unknown): RefinePromptRequest | null {
  if (
    !isRecord(value)
    || typeof value.draft !== 'string'
    || !isPromptRefinementTarget(value.target)
  ) {
    return null;
  }
  if (!value.draft.trim() || value.draft.length > promptRefinementTargetMaxLength(value.target)) {
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
  if (!refinedPrompt || refinedPrompt.length > promptRefinementTargetMaxLength(target)) return null;
  return { success: true, refinedPrompt };
}
