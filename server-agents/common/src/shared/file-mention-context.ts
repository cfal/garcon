export { PREAMBLE_FILE_CONTEXT_SEPARATOR as FILE_CONTEXT_SEPARATOR } from '@garcon/common/preambles';
import { PREAMBLE_FILE_CONTEXT_SEPARATOR } from '@garcon/common/preambles';

export function stripResolvedFileMentionContext(content: string): string {
  const index = content.indexOf(PREAMBLE_FILE_CONTEXT_SEPARATOR);
  return index === -1 ? content : content.slice(0, index);
}
