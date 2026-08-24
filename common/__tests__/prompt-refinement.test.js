import { describe, expect, it } from 'bun:test';
import {
  PROMPT_REFINEMENT_DRAFT_MAX_LENGTH,
  PROMPT_REFINEMENT_OUTPUT_MAX_LENGTH,
  normalizeRefinePromptRequest,
  normalizeRefinePromptResponse,
  promptRefinementTargetOutputMaxLength,
} from '../prompt-refinement.js';
import { SNIPPET_TEMPLATE_MAX_LENGTH } from '../snippets.js';

describe('prompt refinement contracts', () => {
  it('preserves request whitespace while rejecting blank drafts', () => {
    expect(normalizeRefinePromptRequest({ draft: '  improve this  ', target: 'prompt' })).toEqual({
      draft: '  improve this  ',
      target: 'prompt',
    });
    expect(normalizeRefinePromptRequest({ draft: ' \n\t ', target: 'prompt' })).toBeNull();
  });

  it('enforces the exact request ceiling', () => {
    expect(normalizeRefinePromptRequest({
      draft: 'x'.repeat(PROMPT_REFINEMENT_DRAFT_MAX_LENGTH),
      target: 'prompt',
    })).not.toBeNull();
    expect(normalizeRefinePromptRequest({
      draft: 'x'.repeat(PROMPT_REFINEMENT_DRAFT_MAX_LENGTH + 1),
      target: 'prompt',
    })).toBeNull();
    expect(normalizeRefinePromptRequest({
      draft: 'x'.repeat(SNIPPET_TEMPLATE_MAX_LENGTH),
      target: 'snippet-template',
    })).not.toBeNull();
    expect(normalizeRefinePromptRequest({
      draft: 'x'.repeat(SNIPPET_TEMPLATE_MAX_LENGTH + 1),
      target: 'snippet-template',
    })).toBeNull();
  });

  it('trims only response boundaries and enforces the exact output ceiling', () => {
    expect(promptRefinementTargetOutputMaxLength('prompt')).toBe(
      PROMPT_REFINEMENT_OUTPUT_MAX_LENGTH,
    );
    expect(promptRefinementTargetOutputMaxLength('snippet-template')).toBe(
      SNIPPET_TEMPLATE_MAX_LENGTH,
    );
    expect(normalizeRefinePromptResponse({
      success: true,
      refinedPrompt: '  first\n\nsecond  ',
    }, 'prompt')).toEqual({ success: true, refinedPrompt: 'first\n\nsecond' });
    expect(normalizeRefinePromptResponse({
      success: true,
      refinedPrompt: 'x'.repeat(PROMPT_REFINEMENT_OUTPUT_MAX_LENGTH),
    }, 'prompt')).not.toBeNull();
    expect(normalizeRefinePromptResponse({
      success: true,
      refinedPrompt: 'x'.repeat(PROMPT_REFINEMENT_OUTPUT_MAX_LENGTH + 1),
    }, 'prompt')).toBeNull();
    expect(normalizeRefinePromptResponse({
      success: true,
      refinedPrompt: 'x'.repeat(SNIPPET_TEMPLATE_MAX_LENGTH + 1),
    }, 'snippet-template')).toBeNull();
  });

  it('rejects malformed requests and responses', () => {
    expect(normalizeRefinePromptRequest(null)).toBeNull();
    expect(normalizeRefinePromptRequest({ draft: 42 })).toBeNull();
    expect(normalizeRefinePromptRequest({ draft: 'text' })).toBeNull();
    expect(normalizeRefinePromptRequest({ draft: 'text', target: 'unknown' })).toBeNull();
    expect(normalizeRefinePromptResponse(
      { success: false, refinedPrompt: 'text' },
      'prompt',
    )).toBeNull();
    expect(normalizeRefinePromptResponse(
      { success: true, refinedPrompt: '   ' },
      'prompt',
    )).toBeNull();
  });
});
