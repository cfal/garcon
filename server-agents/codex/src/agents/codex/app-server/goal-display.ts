import type {
  CodexThreadGoal,
  CodexThreadGoalStatus,
} from './protocol.js';

export function goalStatusLabel(status: CodexThreadGoalStatus): string {
  switch (status) {
    case 'active': return 'active';
    case 'paused': return 'paused';
    case 'blocked': return 'blocked';
    case 'usageLimited': return 'usage limited';
    case 'budgetLimited': return 'limited by budget';
    case 'complete': return 'complete';
  }
}

export function formatGoalStatusMessage(goal: CodexThreadGoal | null): string {
  if (!goal) return 'No Codex goal is set.';
  const lines = [
    'Goal',
    `Status: ${goalStatusLabel(goal.status)}`,
    `Objective: ${goal.objective}`,
    `Time used: ${formatGoalElapsedSeconds(goal.timeUsedSeconds)}`,
    `Tokens used: ${formatGoalTokens(goal.tokensUsed)}`,
  ];
  if (goal.tokenBudget !== null) lines.push(`Token budget: ${formatGoalTokens(goal.tokenBudget)}`);
  lines.push('', goalCommandHint(goal.status));
  return lines.join('\n');
}

export function formatGoalUpdatedMessage(action: string, goal: CodexThreadGoal): string {
  return [
    `Codex goal ${action}.`,
    `Objective: ${goal.objective}`,
    formatGoalUsageMessage(goal),
  ].filter(Boolean).join('\n');
}

export function editedGoalStatus(status: CodexThreadGoalStatus): CodexThreadGoalStatus {
  return status === 'budgetLimited' || status === 'complete' ? 'active' : status;
}

function formatGoalUsageMessage(goal: CodexThreadGoal): string {
  const budget = goal.tokenBudget === null ? '' : `/${formatGoalTokens(goal.tokenBudget)}`;
  return `Usage: time ${formatGoalElapsedSeconds(goal.timeUsedSeconds)}, tokens ${formatGoalTokens(goal.tokensUsed)}${budget}.`;
}

function formatGoalElapsedSeconds(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  if (safeSeconds < 60) return `${safeSeconds}s`;
  const minutes = Math.floor(safeSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

function formatGoalTokens(tokens: number): string {
  const safeTokens = Math.max(0, Math.floor(tokens));
  if (safeTokens < 1_000) return String(safeTokens);
  const divisor = safeTokens >= 1_000_000 ? 1_000_000 : 1_000;
  const suffix = divisor === 1_000_000 ? 'M' : 'K';
  const compact = safeTokens / divisor;
  return `${Number.isInteger(compact) ? compact : compact.toFixed(1)}${suffix}`;
}

function goalCommandHint(status: CodexThreadGoalStatus): string {
  switch (status) {
    case 'active':
      return 'Commands: /goal edit <objective>, /goal pause, /goal clear';
    case 'paused':
    case 'blocked':
    case 'usageLimited':
      return 'Commands: /goal edit <objective>, /goal resume, /goal clear';
    case 'budgetLimited':
    case 'complete':
      return 'Commands: /goal edit <objective>, /goal clear';
  }
}
