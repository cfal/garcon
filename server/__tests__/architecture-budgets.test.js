import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Guards against god files. Any production source over MAX_LINES must earn a
// grandfathered ceiling below. The list only shrinks: when a file decomposes to
// MAX_LINES or fewer, its entry must be removed, and no entry may grow past its
// recorded ceiling. New files start under the budget.
const MAX_LINES = 1000;
// Counts code lines only, across queue staging, ordering, boundary parsing,
// transcript snapshots, title-icon source injection, staged active-turn
// settlement ownership, idempotent Stop outcomes with terminal-race and
// abortability settlement, fork admission, and execution ownership.
// This is the ceiling for the execution-ownership unification: steps in that
// work offset each other rather than raising it, because the concepts it
// removes live outside the measured directories and would otherwise let the
// footprint grow while the subsystem is supposedly getting simpler. Strict
// same-turn steering adds a separately reviewed 461-line command admission,
// immutable target, delivery settlement, and pending-input increment. Its
// adversarial-review corrections add 191 lines for bounded identity retention,
// bounded correlation IDs, constant-time conflict lookup, deletion revalidation,
// opaque provider targets, and complete command-outcome telemetry.
// The fourth review adds 58 lines for post-deletion replay and for resolving
// provider file context outside the command lock without changing transcript content.
// The fifth review adds 7 lines for a separate FIFO steering preparation lock.
// The sixth review adds 33 lines for time and resource bounds on uncancellable file reads.
// Turn receipts and their adversarial correctness fixes add a separately reviewed
// 564-line ledger, projection, result budget, terminal-race handling, ordered
// deletion publication, replay-safe admission, and atomic resume-admission
// increment for the consultation CLI.
// Runtime-scoped execution controls add 9 lines for repository identity injection,
// client projection, and rejection of foreign-instance state.
// Atomic queue-sourced steering adds 823 lines for head reservation, delivery
// settlement, idempotent recovery, and provider-neutral pending-input cleanup.
// Follow-up hardening adds 8 lines for uncertainty-token invalidation
// and post-commit pending-status publication isolation.
// Adversarial hardening adds 12 lines for bounded queue-entry identities and
// non-throwing delivery-status publication diagnostics.
// Response identity hardening adds one net line for control-free error authority.
// Same-agent continuation adds a separately reviewed 166 lines for the `/handoff`
// command: source validation, era capture through the shared handoff path,
// registration of a target with no provider session so it seeds itself from the
// carryover projection, and compensation that discards the prepared segment.
// Adversarial review adds 18 lines restoring safety this file's own pressure had
// removed: rejecting a pre-existing target that is not this operation's own
// earlier attempt, binding attachments to the idempotency payload, and re-raising
// a recorded execution failure instead of a misleading projection error. Cutting
// those to hit the previous ceiling is what let the defects in. A further 15
// lines refuse a source whose first turn is still materializing and place the
// continuation in the chat list with a name and metadata, both of which the
// established fork path already did, and undo both when scheduling fails.
// Maintenance retry of abandoned transfer releases adds 6 lines: a widened
// ownership dependency type and the command-service pass-through the
// repair-history route calls.
// A second adversarial round adds 14 lines making self-handoff target creation
// atomic: rejecting a colliding target before the ledger accepts it rather than
// after, transferring compensation ownership at the moment `addChat` publishes
// the target, releasing the writer-root lease a failed preparation still holds,
// and rolling each cleanup step back independently. Trimming to the previous
// ceiling is what produced this round's defects in the first place.
// Self-review of that rollback adds 4 lines: independent cleanup steps also had
// to stay ordered, since stripping the name and list placement from a target
// whose removal failed orphans a chat that is still live.
// Answering a lost-response replay from the ledger rather than from live source
// state adds 4 more, mirroring the ordering ForkCommands already uses so a source
// deleted after a successful handoff cannot turn the retry into a 404.
// Agent-owned projection admission and fail-closed transcript repair add 153 lines
// while removing the queue's competing transcript publication path.
// Ordered transient permission actions add 13 lines for server-instance, ownership,
// turn-owner, and incarnation fencing before provider resolution, plus 3 lines the
// durable-admission fence needed to thread its ownership epoch through admission.
// The queue drainer's terminal-frontier admission fence adds 11 lines so a
// completed provider call cannot admit the next queued entry before its ordered
// terminal event retires the turn.
const EXECUTION_FOOTPRINT_BUDGET = 9190;

const GRANDFATHER = {
  'server/git/diff-engine.ts': 1575,
  'server/routes/chats.ts': 1350,
  'common/chat-types.ts': 1325,
  'server-agents/codex/src/agents/codex/app-server/runtime.ts': 1750,
  'server-agents/opencode/src/agents/opencode/opencode.ts': 1550,
  // Includes correlated interrupt receipts and explicit transport-failure settlement.
  'server-agents/claude/src/agents/claude/claude-cli.ts': 1483,
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

// The footprint ceiling constrains how much machinery this subsystem carries, not how well it
// is explained. Counting comments would price documentation against implementation and push
// authors toward the unexplained code that produced the ownership drift in the first place.
function codeLineCount(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== ''
        && !trimmed.startsWith('//')
        && !trimmed.startsWith('*')
        && !trimmed.startsWith('/*');
    })
    .length;
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
    const lines = executionFiles.reduce((total, file) => total + codeLineCount(file), 0);
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
