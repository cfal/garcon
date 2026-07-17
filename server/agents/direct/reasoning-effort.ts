import {
  normalizeThinkingMode,
  type ThinkingMode,
} from '../../../common/chat-modes.js';

export type DirectExplicitEffort = Exclude<ThinkingMode, 'none'>;

export function resolveDirectExplicitEffort(
  value: unknown,
): DirectExplicitEffort | undefined {
  const effort = normalizeThinkingMode(value);
  return effort === 'none' ? undefined : effort;
}
