import {
  SNIPPET_EXPANDED_MAX_LENGTH,
  SNIPPET_TEMPLATE_VARIABLES,
} from '../../common/snippets.js';
import {
  expandTemplate,
  TemplateExpansionTooLongError,
} from '../../common/template-tokens.js';

export interface SnippetTemplateValues {
  arguments: string;
  projectPath: string;
  chatId: string;
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
