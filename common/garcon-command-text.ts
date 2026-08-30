export function normalizeGarconCommandBody(value: string): string {
  let start = 0;
  let end = value.length;
  if (value.startsWith('\r\n')) start = 2;
  else if (value.startsWith('\n')) start = 1;
  if (value.slice(start, end).endsWith('\r\n')) end -= 2;
  else if (value.slice(start, end).endsWith('\n')) end -= 1;
  return value.slice(start, end);
}
