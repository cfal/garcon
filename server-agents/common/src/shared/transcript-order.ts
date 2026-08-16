export function compareTranscriptTimestamps(left: number, right: number): number {
  const leftValid = left > 0;
  const rightValid = right > 0;
  if (leftValid !== rightValid) return leftValid ? -1 : 1;
  return leftValid && left !== right ? left - right : 0;
}
