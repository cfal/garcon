const MAX_PATHS_PER_GIT_COMMAND = 256;
const MAX_PATHSPEC_BYTES_PER_GIT_COMMAND = 16_000;

export function literalGitPathspec(filePath: string): string {
  return `:(literal)${filePath}`;
}

export function exactGitPathspecs(filePaths: string[]): string[] {
  const paths = Array.from(new Set(filePaths));
  const excludes = paths
    .map((filePath) => `${filePath}/`)
    .filter((prefix) => !paths.some((otherPath) => otherPath.startsWith(prefix)));
  return [
    ...paths.map(literalGitPathspec),
    ...excludes.map((prefix) => `:(exclude,literal)${prefix}`),
  ];
}

export function chunkGitPathspecs(paths: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const filePath of paths) {
    const nextBytes = Buffer.byteLength(filePath) + 1;
    if (
      current.length > 0 &&
      (current.length >= MAX_PATHS_PER_GIT_COMMAND ||
        currentBytes + nextBytes > MAX_PATHSPEC_BYTES_PER_GIT_COMMAND)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(filePath);
    currentBytes += nextBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
