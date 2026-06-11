export function extractFirstLine(text: string | null | undefined): string {
  if (!text) return '';
  const newlineIndex = text.indexOf('\n');
  if (newlineIndex < 0) return text.trim();
  return text.slice(0, newlineIndex).trim();
}
