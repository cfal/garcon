import {
  SNIPPET_EXPANDED_MAX_LENGTH,
  SNIPPET_TEMPLATE_VARIABLES,
} from '../../../common/snippets.js';
import {
  expandTemplate,
  RUNTIME_TEMPLATE_VARIABLES,
  type RuntimeTemplateValues,
  matchTemplateTokens,
  TemplateExpansionTooLongError,
} from '../../../common/template-tokens.js';
import { SnippetDomainError } from './errors.js';

const INSERTION_VARIABLES = ['arguments', 'project_path'] as const;

export interface SnippetTemplateValues {
  arguments: string;
  projectPath: string;
  context: RuntimeTemplateValues;
}

// Defers runtime substitution, including escaped tokens, to the scheduled run.
export function expandScheduledSnippetTemplate(
  template: string,
  values: Pick<SnippetTemplateValues, 'arguments' | 'projectPath'>,
): string {
  try {
    const replacements = {
      arguments: escapeDeferredTokens(values.arguments),
      project_path: escapeDeferredTokens(values.projectPath),
    };
    const expanded = expandTemplate(template, INSERTION_VARIABLES, replacements, SNIPPET_EXPANDED_MAX_LENGTH);
    assertDeferredTokenBoundaries(template, replacements, expanded);
    return expanded;
  } catch (error) {
    if (error instanceof TemplateExpansionTooLongError) throw new SnippetExpansionError();
    throw error;
  }
}

// Escapes replacement tokens once more so the scheduled pass preserves literal values.
function escapeDeferredTokens(value: string): string {
  let result = '';
  let cursor = 0;
  for (const match of matchTemplateTokens(value, RUNTIME_TEMPLATE_VARIABLES)) {
    result += value.slice(cursor, match.index) + `\\${match.raw}`;
    cursor = match.index + match.raw.length;
  }
  return result + value.slice(cursor);
}

function assertDeferredTokenBoundaries(
  template: string,
  replacements: Record<(typeof INSERTION_VARIABLES)[number], string>,
  expanded: string,
): void {
  const expectedTokens: Array<{ index: number; raw: string }> = [];
  let offset = 0;
  const collectFragmentTokens = (fragment: string): void => {
    for (const match of matchTemplateTokens(fragment, RUNTIME_TEMPLATE_VARIABLES)) {
      expectedTokens.push({ index: offset + match.index, raw: match.raw });
    }
    offset += fragment.length;
  };
  let cursor = 0;
  for (const match of matchTemplateTokens(template, INSERTION_VARIABLES)) {
    collectFragmentTokens(template.slice(cursor, match.index));
    collectFragmentTokens(match.escaped ? match.raw.slice(1) : replacements[match.variable]);
    cursor = match.index + match.raw.length;
  }
  collectFragmentTokens(template.slice(cursor));
  const actualTokens = [...matchTemplateTokens(expanded, RUNTIME_TEMPLATE_VARIABLES)];
  // Joined fragments must not synthesize tokens or change an existing token's escape.
  if (actualTokens.length !== expectedTokens.length || actualTokens.some((match, index) => (
    match.index !== expectedTokens[index]?.index || match.raw !== expectedTokens[index]?.raw
  ))) {
    throw new SnippetDomainError(
      'SNIPPET_VALIDATION_FAILED',
      'Scheduled snippet replacements must not create or escape adjacent template variables. Add a separator.',
      422,
    );
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
        ...values.context,
      },
      SNIPPET_EXPANDED_MAX_LENGTH,
    );
  } catch (error) {
    if (error instanceof TemplateExpansionTooLongError) throw new SnippetExpansionError();
    throw error;
  }
}
