import {
  matchSnippetTemplateTokens,
  SNIPPET_EXPANDED_MAX_LENGTH,
} from '../../common/snippets.js';

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

  for (const match of matchSnippetTemplateTokens(template)) {
    append(template.slice(cursor, match.index));
    if (match.escaped) append(match.raw.slice(1));
    else
      append(match.variable === 'arguments' ? values.arguments : values.projectPath);
    cursor = match.index + match.raw.length;
  }

  append(template.slice(cursor));
  return chunks.join('');
}
