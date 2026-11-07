import { dedupeHiddenBashCommandPatterns, type HiddenBashCommandPattern } from './hidden-bash-command-patterns.js';

export type BashCommandMatcher = (command: string) => boolean;
export const BASH_MATCHER_REVISION = 1;

function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (const character of pattern) {
    if (character === '*') source += '[\\s\\S]*';
    else if (character === '?') source += '[\\s\\S]';
    else source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${source}$`, 'u');
}

export function compileHiddenBashCommandPatterns(patterns: readonly HiddenBashCommandPattern[]): BashCommandMatcher | null {
  const compiled: RegExp[] = [];
  for (const { pattern, mode } of patterns) {
    if (pattern.length === 0) continue;
    try { compiled.push(mode === 'regex' ? new RegExp(pattern) : globToRegExp(pattern)); }
    catch { /* Invalid persisted patterns retain the existing no-match behavior. */ }
  }
  return compiled.length ? command => compiled.some(regex => regex.test(command)) : null;
}

export function bashRevisionInput(patterns: readonly HiddenBashCommandPattern[]): string {
  return JSON.stringify([BASH_MATCHER_REVISION, dedupeHiddenBashCommandPatterns(patterns)]);
}
