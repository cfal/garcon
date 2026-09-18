import path from 'node:path';

function pathFlavor(value: string) {
  return /^(?:[A-Za-z]:\/|\/\/)/u.test(value) ? path.win32 : path.posix;
}

export function isCanonicalNodePath(value: string): boolean {
  if (!value.isWellFormed() || value.includes('\0')) return false;
  if (value.split('/').some((segment) => segment === '.' || segment === '..')) return false;
  const flavor = pathFlavor(value);
  if (flavor === path.win32 && value.includes('\\')) return false;
  if (!flavor.isAbsolute(value)) return false;
  if (value.endsWith('/') && flavor.parse(value).root !== value) return false;
  const normalized = flavor.normalize(value);
  return (flavor === path.win32 ? normalized.replaceAll('\\', '/') : normalized) === value;
}

export function parentNodePath(value: string): string {
  const flavor = pathFlavor(value);
  const parent = flavor.dirname(value);
  return flavor === path.win32 ? parent.replaceAll('\\', '/') : parent;
}
