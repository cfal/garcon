import path from 'node:path';
import type { ExecutorPath } from '../../common/executor-path.js';

export function toExecutorPath(nativePath: string, separator = path.sep): ExecutorPath {
  return separator === '\\' ? nativePath.replaceAll('\\', '/') : nativePath;
}

export function toNativePath(executorPath: ExecutorPath, separator = path.sep): string {
  return separator === '\\' ? executorPath.replaceAll('/', '\\') : executorPath;
}
