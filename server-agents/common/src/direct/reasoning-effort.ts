import {
  normalizeThinkingMode,
  type ThinkingMode,
} from '@garcon/common/chat-modes';

export type DirectExplicitEffort = Exclude<ThinkingMode, 'none'>;

export function resolveDirectExplicitEffort(
  value: unknown,
): DirectExplicitEffort | undefined {
  const effort = normalizeThinkingMode(value);
  return effort === 'none' ? undefined : effort;
}
