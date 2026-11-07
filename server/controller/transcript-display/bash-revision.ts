import { compileHiddenBashCommandPatterns } from '../../../common/transcript-display-matcher.js';
import type { HiddenBashCommandPattern } from '../../../common/hidden-bash-command-patterns.js';
import { DisplayStore } from './store.js';

export interface BashPreparation { revision: string; prepared_through: number; status: string; failure_code: string | null }
interface Candidate { ordinal: number; use_ordinal: number; class_id: number; weight: number; command: string }

export function prepareBashFrame(store: DisplayStore, revision: string, patterns: readonly HiddenBashCommandPattern[], goal: number): number {
  const existing = store.get<BashPreparation>('SELECT * FROM bash_revision WHERE revision = ?', revision);
  if (existing?.status === 'failed') throw Object.assign(new Error('Bash revision failed'), { code: 'DISPLAY_FILTER_TIMEOUT' });
  if (existing?.status === 'pruning') throw Object.assign(new Error('Bash revision is being retired'), { code: 'DISPLAY_PREPARING' });
  const frontier = existing?.prepared_through ?? 0;
  goal = Math.min(goal, store.manifest()!.prepared_through);
  const rows: Candidate[] = [];
  let bytes = 0;
  const query = store.db.query<Candidate, [number, number]>(
    'SELECT e.*, i.command FROM bash_event e JOIN bash_input i ON i.use_ordinal = e.use_ordinal WHERE e.ordinal > ? AND e.ordinal <= ? ORDER BY e.ordinal LIMIT 64',
  );
  for (const row of query.iterate(frontier, goal)) {
    if (rows.length && bytes + row.command.length * 2 > 256 * 1024) break;
    rows.push(row);
    bytes += row.command.length * 2;
  }
  const decisions = new Map<number, boolean>();
  const match = compileHiddenBashCommandPatterns(patterns);
  for (const row of rows) {
    if (decisions.has(row.use_ordinal)) continue;
    const prior = store.get<{ eligible: number }>('SELECT eligible FROM bash_decision WHERE revision = ? AND use_ordinal = ?', revision, row.use_ordinal);
    decisions.set(row.use_ordinal, prior ? prior.eligible === 1 : !match?.(row.command));
  }
  const through = rows.length ? rows.at(-1)!.ordinal : goal;
  return store.db.transaction(() => {
    for (const [ordinal, eligible] of decisions) store.run('INSERT OR IGNORE INTO bash_decision VALUES (?, ?, ?)', revision, ordinal, Number(eligible));
    for (const row of rows) {
      if (!decisions.get(row.use_ordinal)) continue;
      const last = store.get<{ rank: number; cumulative_weight: number }>('SELECT rank, cumulative_weight FROM bash_posting WHERE revision = ? AND class_id = ? ORDER BY ordinal DESC LIMIT 1', revision, row.class_id);
      store.run('INSERT INTO bash_posting VALUES (?, ?, ?, ?, ?)', revision, row.class_id, row.ordinal,
        (last?.rank ?? 0) + 1, (last?.cumulative_weight ?? 0) + row.weight);
    }
    store.run("INSERT INTO bash_revision VALUES (?, ?, 'preparing', NULL) ON CONFLICT(revision) DO UPDATE SET prepared_through = excluded.prepared_through, status = excluded.status, failure_code = NULL", revision, through);
    if (through === goal) store.run("UPDATE bash_revision SET status = 'available' WHERE revision = ?", revision);
    return through;
  })();
}

export function pruneBashRevision(store: DisplayStore, revision: string): boolean {
  return store.db.transaction(() => {
    store.run("UPDATE bash_revision SET status = 'pruning', prepared_through = 0, failure_code = NULL WHERE revision = ?", revision);
    for (const table of ['bash_posting', 'bash_decision']) {
      const key = table === 'bash_posting' ? '(class_id, ordinal)' : '(use_ordinal)';
      store.run(`DELETE FROM ${table} WHERE revision = ? AND ${key} IN (SELECT ${key.slice(1, -1)} FROM ${table} WHERE revision = ? LIMIT 2000)`, revision, revision);
      if (store.get(`SELECT 1 FROM ${table} WHERE revision = ? LIMIT 1`, revision)) return false;
    }
    store.run('DELETE FROM bash_revision WHERE revision = ?', revision);
    return true;
  })();
}
