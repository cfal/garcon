import { describe, expect, it } from 'bun:test';
import { snippetTemplateUsesProjectPath } from '../snippets.js';

describe('snippetTemplateUsesProjectPath', () => {
  it('detects an unescaped project path token', () => {
    expect(snippetTemplateUsesProjectPath('Review in {{project_path}}')).toBe(true);
    expect(snippetTemplateUsesProjectPath('{{project_path}}')).toBe(true);
  });

  it('ignores templates without the token', () => {
    expect(snippetTemplateUsesProjectPath('Review {{arguments}}')).toBe(false);
    expect(snippetTemplateUsesProjectPath('No tokens here')).toBe(false);
    expect(snippetTemplateUsesProjectPath('')).toBe(false);
  });

  it('ignores escaped tokens', () => {
    expect(snippetTemplateUsesProjectPath('Keep \\{{project_path}} literal')).toBe(false);
    expect(
      snippetTemplateUsesProjectPath('\\{{project_path}} and {{project_path}}'),
    ).toBe(true);
  });
});
