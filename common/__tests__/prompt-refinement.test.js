import { describe, expect, it } from 'bun:test';
import {
  PROMPT_REFINEMENT_DRAFT_MAX_LENGTH,
  PROMPT_REFINEMENT_OUTPUT_MAX_LENGTH,
  normalizeRefinePromptRequest,
  normalizeRefinePromptResponse,
} from '../prompt-refinement.js';

describe('prompt refinement contracts', () => {
  it('preserves request whitespace while rejecting blank drafts', () => {
    expect(normalizeRefinePromptRequest({ draft: '  improve this  ' })).toEqual({
      draft: '  improve this  ',
    });
    expect(normalizeRefinePromptRequest({ draft: ' \n\t ' })).toBeNull();
  });

  it('enforces the exact request ceiling', () => {
    expect(normalizeRefinePromptRequest({
      draft: 'x'.repeat(PROMPT_REFINEMENT_DRAFT_MAX_LENGTH),
    })).not.toBeNull();
    expect(normalizeRefinePromptRequest({
      draft: 'x'.repeat(PROMPT_REFINEMENT_DRAFT_MAX_LENGTH + 1),
    })).toBeNull();
  });

  it('trims only response boundaries and enforces the exact output ceiling', () => {
    expect(normalizeRefinePromptResponse({
      success: true,
      refinedPrompt: '  first\n\nsecond  ',
    })).toEqual({ success: true, refinedPrompt: 'first\n\nsecond' });
    expect(normalizeRefinePromptResponse({
      success: true,
      refinedPrompt: 'x'.repeat(PROMPT_REFINEMENT_OUTPUT_MAX_LENGTH),
    })).not.toBeNull();
    expect(normalizeRefinePromptResponse({
      success: true,
      refinedPrompt: 'x'.repeat(PROMPT_REFINEMENT_OUTPUT_MAX_LENGTH + 1),
    })).toBeNull();
  });

  it('rejects malformed requests and responses', () => {
    expect(normalizeRefinePromptRequest(null)).toBeNull();
    expect(normalizeRefinePromptRequest({ draft: 42 })).toBeNull();
    expect(normalizeRefinePromptResponse({ success: false, refinedPrompt: 'text' })).toBeNull();
    expect(normalizeRefinePromptResponse({ success: true, refinedPrompt: '   ' })).toBeNull();
  });
});
