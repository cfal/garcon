import { describe, expect, it } from 'bun:test';
import { SNIPPET_EXPANDED_MAX_LENGTH } from '../../../common/snippets.ts';
import { expandSnippetTemplate } from '../template.ts';

describe('snippet template expansion', () => {
  it('expands the two exact markers and preserves multiline arguments', () => {
    expect(
      expandSnippetTemplate('Review {{arguments}} in {{project_path}}', {
        arguments: 'API\ncontracts',
        projectPath: '/repo',
      }),
    ).toBe('Review API\ncontracts in /repo');
  });

  it('keeps escaped, spaced, and unknown markers literal', () => {
    expect(
      expandSnippetTemplate('\\{{arguments}} {{ arguments }} {{unknown}}', {
        arguments: 'ignored',
        projectPath: '/repo',
      }),
    ).toBe('{{arguments}} {{ arguments }} {{unknown}}');
  });

  it('is single-pass for marker-shaped replacement values', () => {
    expect(
      expandSnippetTemplate('{{arguments}}', {
        arguments: '{{project_path}}',
        projectPath: '/repo',
      }),
    ).toBe('{{project_path}}');
  });

  it('rejects output beyond the configured bound before joining it', () => {
    expect(() =>
      expandSnippetTemplate('{{arguments}}{{arguments}}{{arguments}}', {
        arguments: 'x'.repeat(Math.floor(SNIPPET_EXPANDED_MAX_LENGTH / 2)),
        projectPath: '/repo',
      }),
    ).toThrow('Expanded snippet exceeds');
  });
});
