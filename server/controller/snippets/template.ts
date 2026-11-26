import {
  expandScheduledSnippetTemplate as expandSharedScheduledSnippetTemplate,
  expandSnippetTemplate as expandSharedSnippetTemplate,
  ScheduledSnippetBoundaryError,
  SnippetExpansionError,
  type SnippetTemplateValues,
} from '../../../common/snippet-template.js';
import { SnippetDomainError } from './errors.js';

function mapTemplateError(error: unknown): never {
  if (error instanceof SnippetExpansionError || error instanceof ScheduledSnippetBoundaryError) {
    throw new SnippetDomainError(error.code, error.message, 422);
  }
  throw error;
}

export function expandSnippetTemplate(
  template: string,
  values: SnippetTemplateValues,
): string {
  try {
    return expandSharedSnippetTemplate(template, values);
  } catch (error) {
    mapTemplateError(error);
  }
}

export function expandScheduledSnippetTemplate(
  template: string,
  values: Pick<SnippetTemplateValues, 'arguments' | 'projectPath'>,
): string {
  try {
    return expandSharedScheduledSnippetTemplate(template, values);
  } catch (error) {
    mapTemplateError(error);
  }
}
