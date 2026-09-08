function cleanCell(value: string): string {
  return value.replace(/\s+/g, ' ').trim() || '-';
}

export function formatTextTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const cleanHeaders = headers.map(cleanCell);
  const cleanRows = rows.map((row) => row.map(cleanCell));
  const widths = cleanHeaders.map((header, column) => Math.max(
    header.length,
    ...cleanRows.map((row) => row[column]?.length ?? 0),
  ));
  const render = (row: readonly string[]) => row
    .map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0))
    .join('  ');
  return [
    render(cleanHeaders),
    render(widths.map((width) => '-'.repeat(width))),
    ...cleanRows.map(render),
  ].join('\n');
}
