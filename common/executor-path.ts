// Executor paths use forward slashes; POSIX filename backslashes remain literal.
export type ExecutorPath = string;

export function isWithinExecutorPath(root: ExecutorPath, candidate: ExecutorPath): boolean {
  return candidate === root || candidate.startsWith(root.endsWith('/') ? root : `${root}/`);
}
