import { GitDomainError } from './git-domain-error.js';


// Splits `git log -z` output whose format separates fields with %x00. Subjects may hold any
// byte except NUL, so a printable separator could split one commit into several records.
export function nulRecords(output: string, fieldCount: number, description: string): string[][] {
  const fields = output.split('\0');
  if (fields.pop() !== '' || fields.length % fieldCount !== 0) {
    throw new GitDomainError('INVALID_RESULT', `Git returned an unreadable ${description}.`);
  }
  const records: string[][] = [];
  for (let offset = 0; offset < fields.length; offset += fieldCount) {
    records.push(fields.slice(offset, offset + fieldCount));
  }
  return records;
}
