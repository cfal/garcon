import { directoryNameProblem, type DirectoryNameProblem } from '../../common/file-contracts.js';
import { ValidationDomainError } from './domain-error.js';

const PROBLEM_MESSAGES: Readonly<Record<DirectoryNameProblem, string>> = {
  empty: 'A directory name is required',
  reserved: 'Directory name is reserved',
  'invalid-character': 'Directory name cannot contain path separators or control characters',
  'too-long': 'Directory name is too long',
};

// Local and remote file services reject the same names with the same error.
export function assertDirectoryName(name: unknown): asserts name is string {
  if (typeof name !== 'string') throw new ValidationDomainError(PROBLEM_MESSAGES.empty);
  const problem = directoryNameProblem(name);
  if (problem) throw new ValidationDomainError(PROBLEM_MESSAGES[problem]);
}
