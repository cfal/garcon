const CLOSED_THINK_BLOCK_PATTERN = /<think\b[^>]*>[\s\S]*?<\/think\s*>/gi;
const UNCLOSED_THINK_BLOCK_PATTERN = /<think\b[^>]*>[\s\S]*$/i;
const ORPHAN_THINK_CLOSE_PATTERN = /<\/think\s*>/gi;

export function stripThinkBlocks(text: string): string {
  return text
    .replace(CLOSED_THINK_BLOCK_PATTERN, '')
    .replace(UNCLOSED_THINK_BLOCK_PATTERN, '')
    .replace(ORPHAN_THINK_CLOSE_PATTERN, '')
    .trim();
}
