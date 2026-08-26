const PRIORITY_LADDER: readonly (readonly string[])[] = [
  ['user-message'],
  ['assistant-message'],
  ['read-tool-use', 'grep-tool-use', 'glob-tool-use', 'list-tool-use'],
  ['edit-tool-use', 'write-tool-use', 'apply-patch-tool-use'],
  ['bash-tool-use', 'exec-tool-use'],
];

export const PROJECTION_LONG_TAIL_LEVEL = PRIORITY_LADDER.length;

export interface PrioritizedProjectionEntry {
  readonly level: number;
  readonly turn: number;
  readonly text: string;
  refit(maximumCost: number, cost: (text: string) => number): string;
}

export interface ProjectionSelection<
  Entry extends PrioritizedProjectionEntry = PrioritizedProjectionEntry,
> {
  readonly selected: readonly Entry[];
  readonly truncated: boolean;
  readonly admissionCost: number;
}

export function projectionPriorityLevel(type: string): number {
  const index = PRIORITY_LADDER.findIndex((classes) => classes.includes(type));
  return index === -1 ? PROJECTION_LONG_TAIL_LEVEL : index;
}

export function selectPrioritizedProjection<Entry extends PrioritizedProjectionEntry>(input: {
  readonly entries: readonly Entry[];
  readonly turnCount: number;
  readonly maximumCost: number;
  readonly truncationMarkerCost: number;
  readonly cost: (text: string) => number;
  readonly recentTurnsVerbatim?: number;
}): ProjectionSelection<Entry> {
  const admitted = new Set<PrioritizedProjectionEntry>();
  const asks = admitLevel({
    ...input,
    level: 0,
    admitted,
    used: input.truncationMarkerCost,
    pinOldest: true,
  });
  const recentTurns = input.recentTurnsVerbatim ?? 3;
  const pinnedFrom = Math.max(0, input.turnCount - recentTurns);
  const pinned = admitPinnedTurns({
    ...input,
    pinnedFrom,
    admitted,
    used: asks.used,
  });
  const used = runLadder({
    ...input,
    turnLimit: pinned.admittedFrom,
    admitted,
    used: pinned.used,
  });

  const selected = input.entries.filter((entry) => admitted.has(entry));
  if (selected.length === 0 && input.entries.length > 0) {
    const latest = input.entries.at(-1)!;
    const fitted = latest.refit(input.maximumCost - used, input.cost);
    if (fitted) selected.push({ ...latest, text: fitted });
  }
  return {
    selected,
    truncated: selected.length !== input.entries.length,
    admissionCost: input.truncationMarkerCost
      + selected.reduce((total, entry) => total + input.cost(entry.text), 0),
  };
}

function admitPinnedTurns(input: {
  readonly entries: readonly PrioritizedProjectionEntry[];
  readonly turnCount: number;
  readonly pinnedFrom: number;
  readonly admitted: Set<PrioritizedProjectionEntry>;
  readonly used: number;
  readonly maximumCost: number;
  readonly cost: (text: string) => number;
}): { readonly used: number; readonly admittedFrom: number } {
  for (let earliest = input.pinnedFrom; earliest < input.turnCount; earliest += 1) {
    const candidates = input.entries.filter((entry) => (
      entry.turn >= earliest && !input.admitted.has(entry)
    ));
    const cost = candidates.reduce((total, entry) => total + input.cost(entry.text), 0);
    if (input.used + cost <= input.maximumCost) {
      for (const entry of candidates) input.admitted.add(entry);
      return { used: input.used + cost, admittedFrom: earliest };
    }
  }
  return { used: input.used, admittedFrom: input.turnCount };
}

function admitLevel(input: {
  readonly entries: readonly PrioritizedProjectionEntry[];
  readonly level: number;
  readonly admitted: Set<PrioritizedProjectionEntry>;
  readonly used: number;
  readonly maximumCost: number;
  readonly cost: (text: string) => number;
  readonly turnLimit?: number;
  readonly pinOldest?: boolean;
}): { readonly used: number; readonly complete: boolean } {
  const turnLimit = input.turnLimit ?? Number.POSITIVE_INFINITY;
  const candidates = input.entries.filter((entry) => (
    entry.turn < turnLimit
    && entry.level === input.level
    && !input.admitted.has(entry)
  ));
  const cost = candidates.reduce((total, entry) => total + input.cost(entry.text), 0);
  if (input.used + cost <= input.maximumCost) {
    for (const entry of candidates) input.admitted.add(entry);
    return { used: input.used + cost, complete: true };
  }

  let total = input.used;
  for (const pin of input.pinOldest ? [candidates.at(-1), candidates[0]] : []) {
    if (!pin || input.admitted.has(pin) || total + input.cost(pin.text) > input.maximumCost) {
      continue;
    }
    input.admitted.add(pin);
    total += input.cost(pin.text);
  }
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (input.admitted.has(candidate)) continue;
    const entryCost = input.cost(candidate.text);
    if (total + entryCost > input.maximumCost) break;
    input.admitted.add(candidate);
    total += entryCost;
  }
  return { used: total, complete: false };
}

function runLadder(input: {
  readonly entries: readonly PrioritizedProjectionEntry[];
  readonly turnLimit: number;
  readonly admitted: Set<PrioritizedProjectionEntry>;
  readonly used: number;
  readonly maximumCost: number;
  readonly cost: (text: string) => number;
}): number {
  let total = input.used;
  for (let level = 0; level <= PROJECTION_LONG_TAIL_LEVEL; level += 1) {
    const outcome = admitLevel({ ...input, level, used: total });
    total = outcome.used;
    if (!outcome.complete) break;
  }
  return total;
}
