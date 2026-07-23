import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Guards against god files. Any production source over MAX_LINES must earn a
// grandfathered ceiling below. The list only shrinks: when a file decomposes to
// MAX_LINES or fewer, its entry must be removed, and no entry may grow past its
// recorded ceiling. New files start under the budget.
const MAX_LINES = 1000;
// Includes queue staging, ordering, boundary parsing, and exact turn settlement ownership.
const EXECUTION_FOOTPRINT_BUDGET = 7068;

const GRANDFATHER = {
  'server/git/diff-engine.ts': 1575,
  'server/routes/chats.ts': 1350,
  'common/chat-types.ts': 1325,
  'server-agents/codex/src/agents/codex/app-server/runtime.ts': 1750,
  'server-agents/opencode/src/agents/opencode/opencode.ts': 1550,
  'server-agents/claude/src/agents/claude/claude-cli.ts': 1450,
};

const SKIP_DIRS = new Set(['__tests__', 'node_modules', 'dist', 'build']);

function serverAgentSrcRoots() {
  return readdirSync('server-agents', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join('server-agents', entry.name, 'src'))
    .filter((path) => existsSync(path));
}

function productionFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : productionFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

function lineCount(file) {
  const source = readFileSync(file, 'utf8');
  if (source.length === 0) return 0;
  const lines = source.split('\n').length;
  return source.endsWith('\n') ? lines - 1 : lines;
}

function isExecutionFootprintFile(file) {
  return file.startsWith('server/chat-execution/')
    || file.startsWith('server/commands/')
    || /^server\/chats\/pending-(?:input-matching|user-input).*\.ts$/.test(file);
}

const roots = ['server', 'common', ...serverAgentSrcRoots()];
const files = roots.flatMap(productionFiles);

describe('server architecture budgets', () => {
  test('discovers a plausible number of production files', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  test('no production file exceeds its line budget', () => {
    for (const file of files) {
      const ceiling = GRANDFATHER[file] ?? MAX_LINES;
      const lines = lineCount(file);
      expect(lines, `${file} has ${lines} lines (ceiling ${ceiling})`).toBeLessThanOrEqual(ceiling);
    }
  });

  test('execution and pending-input footprint stays within its reviewed budget', () => {
    const executionFiles = files.filter(isExecutionFootprintFile);
    expect(executionFiles.length).toBeGreaterThan(20);
    const lines = executionFiles.reduce((total, file) => total + lineCount(file), 0);
    expect(lines).toBeLessThanOrEqual(EXECUTION_FOOTPRINT_BUDGET);
  });

  test('grandfather entries stay above the budget and reference real files', () => {
    for (const [file, ceiling] of Object.entries(GRANDFATHER)) {
      expect(existsSync(file), `grandfathered file missing; remove it: ${file}`).toBe(true);
      expect(ceiling).toBeGreaterThan(MAX_LINES);
      const lines = lineCount(file);
      expect(
        lines,
        `${file} is ${lines} lines, at or below ${MAX_LINES}; remove it from GRANDFATHER`,
      ).toBeGreaterThan(MAX_LINES);
    }
  });
});
