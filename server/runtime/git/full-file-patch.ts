export function buildFullFileAddedPatch(contentAfter: string): string {
  const lines = fullFileLines(contentAfter);
  if (lines.length === 0) return '';
  const eof = contentAfter.endsWith('\n') ? '' : '\n\\ No newline at end of file';
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}${eof}`;
}

export function countFullFileAddedLines(contentAfter: string): number {
  return fullFileLines(contentAfter).length;
}

function fullFileLines(content: string): string[] {
  if (!content) return [];
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}
