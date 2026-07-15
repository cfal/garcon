import { describe, expect, it } from 'bun:test';
import {
  SNIPPET_ARGUMENTS_MAX_LENGTH,
  SNIPPET_EXPANDED_MAX_LENGTH,
  normalizeExpandSnippetRequest,
  normalizeExpandSnippetResponse,
  normalizeSnippetDefinitionInput,
  normalizeSnippetsSnapshot,
} from '../../../common/snippets.ts';

function snippet(overrides = {}) {
  return {
    id: 'snippet-a',
    shortName: 'review_api',
    template: '\nReview {{arguments}}\n',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('snippet contracts', () => {
  it('preserves valid names and multiline template whitespace without normalization', () => {
    expect(
      normalizeSnippetDefinitionInput({
        shortName: 'review_api-2',
        template: '\nReview {{arguments}}\n',
      }),
    ).toEqual({
      shortName: 'review_api-2',
      template: '\nReview {{arguments}}\n',
    });
    for (const shortName of [
      'Review',
      ' review',
      'review me',
      '_review',
      'review.',
      '',
    ]) {
      expect(
        normalizeSnippetDefinitionInput({ shortName, template: 'text' }),
      ).toBeNull();
    }

    const inherited = Object.create({ shortName: 'review_api' });
    inherited.template = 'text';
    expect(normalizeSnippetDefinitionInput(inherited)).toBeNull();
  });

  it('rejects duplicate IDs, duplicate names, and malformed revisions', () => {
    expect(
      normalizeSnippetsSnapshot({ revision: -1, snippets: [] }),
    ).toBeNull();
    expect(
      normalizeSnippetsSnapshot({
        revision: 1,
        snippets: [snippet(), snippet({ id: 'snippet-b' })],
      }),
    ).toBeNull();
    expect(
      normalizeSnippetsSnapshot({
        revision: 1,
        snippets: [snippet(), snippet({ shortName: 'other' })],
      }),
    ).toBeNull();
  });

  it('preserves raw arguments and accepts only explicit expansion contexts', () => {
    expect(
      normalizeExpandSnippetRequest({
        shortName: 'review_api',
        arguments: 'first  line\nsecond',
        context: { type: 'chat', chatId: ' 123 ' },
      }),
    ).toEqual({
      shortName: 'review_api',
      arguments: 'first  line\nsecond',
      context: { type: 'chat', chatId: '123' },
    });
    expect(
      normalizeExpandSnippetRequest({
        shortName: 'review_api',
        arguments: '',
        context: { type: 'unknown', projectPath: '/repo' },
      }),
    ).toBeNull();
    expect(
      normalizeExpandSnippetRequest({
        shortName: 'review_api',
        arguments: 'x'.repeat(SNIPPET_ARGUMENTS_MAX_LENGTH + 1),
        context: { type: 'project', projectPath: '/repo' },
      }),
    ).toBeNull();
  });

  it('validates expansion response identity and output shape', () => {
    expect(
      normalizeExpandSnippetResponse({
        success: true,
        snippetId: 'snippet-a',
        shortName: 'review_api',
        expandedText: 'Review the API',
      }),
    ).toEqual({
      success: true,
      snippetId: 'snippet-a',
      shortName: 'review_api',
      expandedText: 'Review the API',
    });
    expect(
      normalizeExpandSnippetResponse({
        success: true,
        snippetId: '',
        shortName: 'review_api',
        expandedText: 'text',
      }),
    ).toBeNull();
    expect(
      normalizeExpandSnippetResponse({
        success: true,
        snippetId: 'snippet-a',
        shortName: 'review_api',
        expandedText: 'x'.repeat(SNIPPET_EXPANDED_MAX_LENGTH + 1),
      }),
    ).toBeNull();
  });
});
