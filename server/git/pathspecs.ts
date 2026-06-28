const MAX_PATHS_PER_GIT_COMMAND = 256;
const MAX_PATHSPEC_BYTES_PER_GIT_COMMAND = 16_000;

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
