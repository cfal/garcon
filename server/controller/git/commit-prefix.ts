// Computes the directory prefix used when generated commit messages
// should include a path scope.

const LOCK_EXTENSIONS = new Set(['.lock', '.sum', '.lockb']);

const GENERIC_TOKENS = new Set([
  'src',
  'source',
  'sources',
  'lib',
  'pkg',
  'packages',
  'packages-ts',
  'internal',
  'cmd',
  'app',
  'apps',
]);

function isIgnoredFile(filePath: string): boolean {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot === -1) return false;
  return LOCK_EXTENSIONS.has(filePath.substring(lastDot));
}

export function computeCommonDirPrefix(filePaths: string[], trimExtension = false): string {
  if (!filePaths.length) return '';

  let startIdx = 0;
  let allIgnored = false;
  while (startIdx < filePaths.length && isIgnoredFile(filePaths[startIdx])) {
    startIdx += 1;
  }
  if (startIdx >= filePaths.length) {
    startIdx = 0;
    allIgnored = true;
  }

  let currentPrefix = filePaths[startIdx];

  for (let index = startIdx + 1; index < filePaths.length; index += 1) {
    const filePath = filePaths[index];
    if (!allIgnored && isIgnoredFile(filePath)) continue;

    while (currentPrefix && !filePath.startsWith(`${currentPrefix}/`)) {
      const tokens = currentPrefix.split('/');
      tokens.pop();
      currentPrefix = tokens.join('/');
    }
  }

  if (!currentPrefix) return '';

  const tokens = currentPrefix.split('/');
  const meaningful = tokens.filter((token) => !GENERIC_TOKENS.has(token));
  if (!meaningful.length) return '';

  let prefix = meaningful.join('/');

  if (trimExtension) {
    const dot = prefix.lastIndexOf('.');
    const slash = prefix.lastIndexOf('/');
    if (dot > slash) {
      prefix = prefix.substring(0, dot);
    }
  }

  return prefix;
}

export function applyDirPrefix(message: string, prefix: string): string {
  if (!prefix || !message) return message;

  const lines = message.split('\n');
  lines[0] = `${prefix}: ${lines[0]}`;
  return lines.join('\n');
}
