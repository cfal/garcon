export function redactPushDiagnostic(text: string, source: 'complete-stderr' | 'unverified'): string {
  const separator = text.indexOf('://');
  if (separator < 0) return text;

  // Git prints destinations verbatim: even a quote followed by a newline may still be URL data.
  const start = Math.max(...[' ', '\t', '\r', '\n'].map(char => text.lastIndexOf(char, separator))) + 1;
  const prefix = text.slice(0, start);
  const redacted = prefix + '<remote>';
  if (source !== 'complete-stderr' || !/(?:^|: |\n)fatal: unable to access $/.test(prefix)) return redacted;

  // Only a complete terminal HTTP access error separates the curl reason from the quoted URL.
  const http = /^'https?:\/\/[^'\s]+': ([^\r\n]+)$/i.exec(text.slice(start));
  if (!http || http[1].includes('://') || http[1].includes("': ")) return redacted;
  return redacted + ': ' + http[1];
}
