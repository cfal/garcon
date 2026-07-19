export const FILE_CONTEXT_SEPARATOR = '\n\nReferenced file contents from @file mentions:\n\n';

export function stripResolvedFileMentionContext(content: string): string {
  const index = content.indexOf(FILE_CONTEXT_SEPARATOR);
  return index === -1 ? content : content.slice(0, index);
}
