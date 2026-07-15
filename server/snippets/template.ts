import { SNIPPET_EXPANDED_MAX_LENGTH } from '../../common/snippets.js';

const TOKEN_PATTERN = /\\?\{\{(?:arguments|project_path)\}\}/g;

export interface SnippetTemplateValues {
  arguments: string;
  projectPath: string;
}

export class SnippetExpansionError extends Error {
  readonly code = 'SNIPPET_EXPANSION_TOO_LONG' as const;

  constructor() {
    super(`Expanded snippet exceeds ${SNIPPET_EXPANDED_MAX_LENGTH} characters`);
    this.name = 'SnippetExpansionError';
  }
}

export function expandSnippetTemplate(
  template: string,
  values: SnippetTemplateValues,
): string {
  const chunks: string[] = [];
  let length = 0;
  let cursor = 0;

  const append = (value: string): void => {
    length += value.length;
    if (length > SNIPPET_EXPANDED_MAX_LENGTH) {
      throw new SnippetExpansionError();
    }
    chunks.push(value);
  };

  for (const match of template.matchAll(TOKEN_PATTERN)) {
    const index = match.index;
    const token = match[0];
    append(template.slice(cursor, index));
    if (token.startsWith('\\')) append(token.slice(1));
    else
      append(token === '{{arguments}}' ? values.arguments : values.projectPath);
    cursor = index + token.length;
  }

  append(template.slice(cursor));
  return chunks.join('');
}
