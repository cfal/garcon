import { isRecord } from './json.js';

export const PROMPT_REFINEMENT_DRAFT_MAX_LENGTH = 64_000;
export const PROMPT_REFINEMENT_OUTPUT_MAX_LENGTH = 64_000;

export interface RefinePromptRequest {
  draft: string;
}

export interface RefinePromptResponse {
  success: true;
  refinedPrompt: string;
}

export function normalizeRefinePromptRequest(value: unknown): RefinePromptRequest | null {
  if (!isRecord(value) || typeof value.draft !== 'string') return null;
  if (!value.draft.trim() || value.draft.length > PROMPT_REFINEMENT_DRAFT_MAX_LENGTH) {
    return null;
  }
  return { draft: value.draft };
}

export function normalizeRefinePromptResponse(value: unknown): RefinePromptResponse | null {
  if (!isRecord(value) || value.success !== true || typeof value.refinedPrompt !== 'string') {
    return null;
  }
  const refinedPrompt = value.refinedPrompt.trim();
  if (!refinedPrompt || refinedPrompt.length > PROMPT_REFINEMENT_OUTPUT_MAX_LENGTH) return null;
  return { success: true, refinedPrompt };
}
