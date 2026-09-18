import path from 'node:path';
import type { NodePath } from '../../common/node-path.js';

export function toNodePath(nativePath: string, separator = path.sep): NodePath {
  return separator === '\\' ? nativePath.replaceAll('\\', '/') : nativePath;
}

export function toNativePath(nodePath: NodePath, separator = path.sep): string {
  return separator === '\\' ? nodePath.replaceAll('/', '\\') : nodePath;
}
