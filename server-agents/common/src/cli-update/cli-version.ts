// Matches `2.1.238 (Claude Code)`, `codex-cli 0.169.0`, and prerelease forms
// such as `0.170.0-alpha.1`.
const CLI_VERSION_PATTERN = /(?:^|[\s(])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=[\s)]|$)/m;
const VERSION_PARTS_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseCliVersion(output: string): string | null {
  return CLI_VERSION_PATTERN.exec(output)?.[1] ?? null;
}

export function isCliVersion(value: string): boolean {
  return VERSION_PARTS_PATTERN.test(value);
}

// Orders release versions numerically and ranks a prerelease below its
// release; returns null when either side is not a version.
export function compareCliVersions(left: string, right: string): number | null {
  const a = VERSION_PARTS_PATTERN.exec(left);
  const b = VERSION_PARTS_PATTERN.exec(right);
  if (!a || !b) return null;
  for (let index = 1; index <= 3; index++) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  const leftPre = a[4];
  const rightPre = b[4];
  if (leftPre === rightPre) return 0;
  if (leftPre === undefined) return 1;
  if (rightPre === undefined) return -1;
  return comparePrerelease(leftPre, rightPre);
}

function comparePrerelease(left: string, right: string): number {
  const a = left.split('.');
  const b = right.split('.');
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    const leftNumber = /^\d+$/.test(a[index]!) ? Number(a[index]) : null;
    const rightNumber = /^\d+$/.test(b[index]!) ? Number(b[index]) : null;
    if (leftNumber !== null && rightNumber !== null) {
      if (leftNumber !== rightNumber) return Math.sign(leftNumber - rightNumber);
      continue;
    }
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    const order = a[index]!.localeCompare(b[index]!);
    if (order !== 0) return Math.sign(order);
  }
  return 0;
}
