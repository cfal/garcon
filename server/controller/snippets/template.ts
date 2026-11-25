import {
  expandScheduledSnippetTemplate as expandSharedScheduledSnippetTemplate,
  expandSnippetTemplate,
  ScheduledSnippetBoundaryError,
  SnippetExpansionError,
  type SnippetTemplateValues,
} from '../../../common/snippet-template.js';
import { SnippetDomainError } from './errors.js';

export { expandSnippetTemplate, SnippetExpansionError, type SnippetTemplateValues };

export function expandScheduledSnippetTemplate(
  template: string,
  values: Pick<SnippetTemplateValues, 'arguments' | 'projectPath'>,
): string {
  try {
    return expandSharedScheduledSnippetTemplate(template, values);
  } catch (error) {
    if (error instanceof ScheduledSnippetBoundaryError) {
      throw new SnippetDomainError(error.code, error.message, 422);
    }
    throw error;
  }
}
