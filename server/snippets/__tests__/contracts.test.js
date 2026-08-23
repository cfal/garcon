import { describe, expect, it } from 'bun:test';
import { runInNewContext } from 'node:vm';
import {
  SNIPPET_ARGUMENTS_MAX_LENGTH,
  SNIPPET_EXPANDED_MAX_LENGTH,
  compareSnippetShortNames,
  normalizeExpandSnippetRequest,
  normalizeExpandSnippetResponse,
  normalizeSnippetArgumentsInput,
  normalizeSnippetDefinitionInput,
  normalizeSnippetsSnapshot,
  hasSameSnippetTemplateTokenSignature,
  snippetTemplateTokenSignature,
  snippetTemplateUsesArguments,
} from '../../../common/snippets.ts';

function snippet(overrides = {}) {
  return {
    id: 'snippet-a',
    shortName: 'review_api',
    template: '\nReview {{arguments}}\n',
    defaultArguments: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('snippet contracts', () => {
  it('compares names case-insensitively with numeric segments', () => {
    const names = ['Zulu', 'alpha-10', 'Alpha-2', 'beta'];

    expect(names.sort(compareSnippetShortNames)).toEqual(['Alpha-2', 'alpha-10', 'beta', 'Zulu']);
  });

  it('preserves template and default argument whitespace without normalization', () => {
    expect(
      normalizeSnippetDefinitionInput({
        shortName: 'review_api-2',
        template: '\nReview {{arguments}}\n',
        defaultArguments: '\n staged changes \n',
      }),
    ).toEqual({
      shortName: 'review_api-2',
      template: '\nReview {{arguments}}\n',
      defaultArguments: '\n staged changes \n',
    });
    for (const shortName of ['Review', ' review', 'review me', '_review', 'review.', '']) {
      expect(
        normalizeSnippetDefinitionInput({
          shortName,
          template: 'text',
          defaultArguments: '',
        }),
      ).toBeNull();
    }

    const inherited = Object.create({ shortName: 'review_api' });
    inherited.template = 'text';
    inherited.defaultArguments = '';
    expect(normalizeSnippetDefinitionInput(inherited)).toBeNull();
  });

  it('requires a bounded default and an active arguments token for nonempty values', () => {
    expect(
      normalizeSnippetDefinitionInput({
        shortName: 'review',
        template: 'Review {{arguments}}',
        defaultArguments: '',
      }),
    ).not.toBeNull();
    expect(
      normalizeSnippetDefinitionInput({
        shortName: 'review',
        template: 'Review {{arguments}}',
        defaultArguments: 'x'.repeat(SNIPPET_ARGUMENTS_MAX_LENGTH),
      })?.defaultArguments,
    ).toHaveLength(SNIPPET_ARGUMENTS_MAX_LENGTH);
    for (const definition of [
      { shortName: 'review', template: 'Review {{arguments}}' },
      {
        shortName: 'review',
        template: 'Review {{arguments}}',
        defaultArguments: null,
      },
      {
        shortName: 'review',
        template: 'Review {{arguments}}',
        defaultArguments: 1,
      },
      {
        shortName: 'review',
        template: 'Review {{arguments}}',
        defaultArguments: [],
      },
      {
        shortName: 'review',
        template: 'Review {{arguments}}',
        defaultArguments: {},
      },
      { shortName: 'review', template: 'Review', defaultArguments: 'changes' },
      {
        shortName: 'review',
        template: 'Review \\{{arguments}}',
        defaultArguments: 'changes',
      },
      {
        shortName: 'review',
        template: 'Review {{ arguments }}',
        defaultArguments: 'changes',
      },
      {
        shortName: 'review',
        template: 'Review {{Arguments}}',
        defaultArguments: 'changes',
      },
      {
        shortName: 'review',
        template: 'Review {{arguments}}',
        defaultArguments: 'x'.repeat(SNIPPET_ARGUMENTS_MAX_LENGTH + 1),
      },
    ]) {
      expect(normalizeSnippetDefinitionInput(definition)).toBeNull();
    }
  });

  it('rejects duplicate IDs, duplicate names, and malformed revisions', () => {
    expect(normalizeSnippetsSnapshot({ revision: -1, snippets: [] })).toBeNull();
    expect(
      normalizeSnippetsSnapshot({
        revision: 1,
        snippets: [snippet(), snippet({ id: 'snippet-b' })],
      }),
    ).toBeNull();
    const { defaultArguments: _defaultArguments, ...preDefaultArgumentsSnippet } = snippet();
    expect(
      normalizeSnippetsSnapshot({ revision: 1, snippets: [preDefaultArgumentsSnippet] }),
    ).toBeNull();
    expect(
      normalizeSnippetsSnapshot({
        revision: 1,
        snippets: [snippet(), snippet({ shortName: 'other' })],
      }),
    ).toBeNull();
  });

  it('normalizes snapshots into canonical name order', () => {
    expect(
      normalizeSnippetsSnapshot({
        revision: 1,
        snippets: [
          snippet({ id: 'snippet-10', shortName: 'item-10' }),
          snippet({ id: 'snippet-2', shortName: 'item-2' }),
          snippet({ id: 'snippet-a', shortName: 'alpha' }),
        ],
      })?.snippets.map(({ shortName }) => shortName),
    ).toEqual(['alpha', 'item-2', 'item-10']);
  });

  it('accepts plain records from another JavaScript realm', () => {
    const snapshot = runInNewContext(`({
      revision: 1,
      snippets: [{
        id: 'snippet-a',
        shortName: 'review_api',
        template: 'Review {{arguments}}',
        defaultArguments: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }]
    })`);

    expect(normalizeSnippetsSnapshot(snapshot)).toEqual({
      revision: 1,
      snippets: [snippet({ template: 'Review {{arguments}}' })],
    });
  });

  it('normalizes default and explicit argument variants', () => {
    expect(normalizeSnippetArgumentsInput({ type: 'default' })).toEqual({
      type: 'default',
    });
    expect(normalizeSnippetArgumentsInput({ type: 'default', value: 'ignored' })).toEqual({
      type: 'default',
    });
    expect(
      normalizeSnippetArgumentsInput({
        type: 'value',
        value: ' first\nsecond ',
      }),
    ).toEqual({ type: 'value', value: ' first\nsecond ' });
    for (const value of [
      '',
      null,
      { type: 'value' },
      { type: 'value', value: 1 },
      { type: 'unknown', value: '' },
      { type: 'value', value: 'x'.repeat(SNIPPET_ARGUMENTS_MAX_LENGTH + 1) },
    ]) {
      expect(normalizeSnippetArgumentsInput(value)).toBeNull();
    }
  });

  it('preserves raw explicit arguments and accepts only explicit expansion contexts', () => {
    expect(
      normalizeExpandSnippetRequest({
        shortName: 'review_api',
        arguments: { type: 'value', value: 'first  line\nsecond' },
        context: { type: 'chat', chatId: ' 123 ' },
      }),
    ).toEqual({
      shortName: 'review_api',
      arguments: { type: 'value', value: 'first  line\nsecond' },
      context: { type: 'chat', chatId: '123' },
    });
    expect(
      normalizeExpandSnippetRequest({
        shortName: 'review_api',
        arguments: { type: 'default' },
        context: { type: 'project', projectPath: ' /repo ' },
      }),
    ).toEqual({
      shortName: 'review_api',
      arguments: { type: 'default' },
      context: { type: 'project', projectPath: '/repo' },
    });
    expect(
      normalizeExpandSnippetRequest({
        shortName: 'review_api',
        arguments: { type: 'value', value: '' },
        context: { type: 'unknown', projectPath: '/repo' },
      }),
    ).toBeNull();
    expect(
      normalizeExpandSnippetRequest({
        shortName: 'review_api',
        arguments: {
          type: 'value',
          value: 'x'.repeat(SNIPPET_ARGUMENTS_MAX_LENGTH + 1),
        },
        context: { type: 'project', projectPath: '/repo' },
      }),
    ).toBeNull();
    expect(
      normalizeExpandSnippetRequest({
        shortName: 'review_api',
        arguments: '',
        context: { type: 'project', projectPath: '/repo' },
      }),
    ).toBeNull();
  });

  it('detects only active exact argument markers', () => {
    expect(snippetTemplateUsesArguments('Review {{arguments}}')).toBe(true);
    expect(snippetTemplateUsesArguments('{{project_path}}/{{arguments}}')).toBe(true);
    expect(snippetTemplateUsesArguments('Review \\{{arguments}}')).toBe(false);
    expect(snippetTemplateUsesArguments('{{ arguments }} {{Arguments}}')).toBe(false);
  });

  it('captures ordered active and escaped template-token signatures', () => {
    const template = '{{arguments}} \\{{project_path}} {{arguments}} {{chat_id}}';
    expect(snippetTemplateTokenSignature(template)).toEqual([
      'active:arguments',
      'escaped:project_path',
      'active:arguments',
      'active:chat_id',
    ]);
    expect(hasSameSnippetTemplateTokenSignature(
      template,
      'Prefix {{arguments}} \\{{project_path}} {{arguments}} {{chat_id}} suffix',
    )).toBe(true);
    expect(hasSameSnippetTemplateTokenSignature(
      template,
      '{{arguments}} {{project_path}} {{arguments}} {{chat_id}}',
    )).toBe(false);
    expect(hasSameSnippetTemplateTokenSignature(
      template,
      '{{arguments}} \\{{project_path}} {{chat_id}} {{arguments}}',
    )).toBe(false);
  });

  it('validates expansion response identity and output shape', () => {
    const response = {
      success: true,
      snippetId: 'snippet-a',
      snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
      shortName: 'review_api',
      contextProjectPath: '/repo',
      expandedText: 'Review the API',
    };
    expect(normalizeExpandSnippetResponse(response)).toEqual(response);
    expect(
      normalizeExpandSnippetResponse({
        success: true,
        snippetId: response.snippetId,
        shortName: response.shortName,
        contextProjectPath: response.contextProjectPath,
        expandedText: response.expandedText,
      }),
    ).toBeNull();
    expect(
      normalizeExpandSnippetResponse({
        success: true,
        snippetId: response.snippetId,
        snippetUpdatedAt: response.snippetUpdatedAt,
        shortName: response.shortName,
        expandedText: response.expandedText,
      }),
    ).toBeNull();
    expect(
      normalizeExpandSnippetResponse({
        ...response,
        snippetUpdatedAt: 'not-a-date',
      }),
    ).toBeNull();
    expect(
      normalizeExpandSnippetResponse({
        success: true,
        snippetId: '',
        snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
        shortName: 'review_api',
        contextProjectPath: '/repo',
        expandedText: 'text',
      }),
    ).toBeNull();
    expect(
      normalizeExpandSnippetResponse({
        success: true,
        snippetId: 'snippet-a',
        snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
        shortName: 'review_api',
        contextProjectPath: '/repo',
        expandedText: 'x'.repeat(SNIPPET_EXPANDED_MAX_LENGTH + 1),
      }),
    ).toBeNull();
  });
});
