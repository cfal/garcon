import {
  codexUsageFormat,
  createCodexUsageState,
  parseCodexUsageLine,
  type CodexUsageState,
} from '../../../../server-agents/codex/src/agents/codex/usage-format.ts';

export function validUsageState(state: CodexUsageState): boolean {
  const speeds: readonly unknown[] = [null, 'standard', 'fast', 'ultrafast', 'flex', 'unknown'];
  return speeds.includes(state.threadSpeed)
    && (!state.turn || speeds.includes(state.turn.speed));
}

function snapshot(state: CodexUsageState) {
  const { turn } = state;
  return { ...state, turn: turn && [turn.id, turn.model, turn.speed, turn.hasContext] };
}

export function scanUsage(prefix: readonly unknown[], left: readonly unknown[], right: readonly unknown[]) {
  const run = (lines: readonly unknown[], state: CodexUsageState) =>
    lines.map((line) => parseCodexUsageLine(typeof line === 'string' ? line : JSON.stringify(line), state));
  const state = createCodexUsageState();
  const initial = run(prefix, state);
  const copy = codexUsageFormat.cloneState(state);
  return {
    markers: codexUsageFormat.lineMarkers,
    initial,
    left: run(left, state),
    right: run(right, copy),
    state: snapshot(state),
    copy: snapshot(copy),
  };
}
