import {
  SNIPPET_EXPANDED_MAX_LENGTH,
  SNIPPET_TEMPLATE_VARIABLES,
} from '../../../common/snippets.js';
import {
  expandTemplate,
  CHAT_ID_TEMPLATE_VARIABLE,
  matchTemplateTokens,
  TemplateExpansionTooLongError,
} from '../../../common/template-tokens.js';

export interface SnippetTemplateValues {
  arguments: string;
  projectPath: string;
  chatId: string;
}

// Defers chat ID substitution, including escaped tokens, to the scheduled run.
export function expandScheduledSnippetTemplate(
  template: string,
  values: Pick<SnippetTemplateValues, 'arguments' | 'projectPath'>,
): string {
  // Escapes replacement tokens once more so the scheduled pass preserves literal values.
  const literalValue = (value: string): string => {
    let result = '';
    let cursor = 0;
    for (const match of matchTemplateTokens(value, [CHAT_ID_TEMPLATE_VARIABLE])) {
      result += value.slice(cursor, match.index) + `\\${match.raw}`;
      cursor = match.index + match.raw.length;
    }
    return result + value.slice(cursor);
  };
  try {
    return expandTemplate(template, ['arguments', 'project_path'], {
      arguments: literalValue(values.arguments),
      project_path: literalValue(values.projectPath),
    }, SNIPPET_EXPANDED_MAX_LENGTH);
  } catch (error) {
    if (error instanceof TemplateExpansionTooLongError) throw new SnippetExpansionError();
    throw error;
  }
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
  try {
    return expandTemplate(
      template,
      SNIPPET_TEMPLATE_VARIABLES,
      {
        arguments: values.arguments,
        project_path: values.projectPath,
        chat_id: values.chatId,
      },
      SNIPPET_EXPANDED_MAX_LENGTH,
    );
  } catch (error) {
    if (error instanceof TemplateExpansionTooLongError) throw new SnippetExpansionError();
    throw error;
  }
}
