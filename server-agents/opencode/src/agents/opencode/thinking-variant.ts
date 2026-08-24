import { isRecord } from '@garcon/common/json';
import type { ThinkingMode } from '@garcon/common/chat-modes';

// OpenCode model variants carry provider-specific reasoning controls behind
// effort-like names; the server silently ignores names the model does not
// declare, so selection must be resolved against the declared set here.
// https://github.com/anomalyco/opencode/blob/18b4cb6819d7de0b37927fef60d03927e678c9dd/packages/opencode/src/session/llm/request.ts#L80-L91
const THINKING_MODE_ORDER: readonly ThinkingMode[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function isLadderMode(mode: string): mode is ThinkingMode {
  return mode === 'none' || THINKING_MODE_ORDER.includes(mode as ThinkingMode);
}

function inLadderOrder(modes: readonly string[]): readonly ThinkingMode[] {
  return THINKING_MODE_ORDER.filter((mode) => modes.includes(mode));
}

// Reads the model's declared variant names, keeping only Garcon thinking
// vocabulary. Unrecognized keys (for example "thinking") stay invisible.
export function thinkingModesFromVariants(variants: unknown): readonly ThinkingMode[] | undefined {
  if (!isRecord(variants)) return undefined;
  const modes = Object.keys(variants).filter(isLadderMode);
  if (modes.length === 0) return undefined;
  return [
    ...(modes.includes('none') ? ['none' as const] : []),
    ...inLadderOrder(modes),
  ];
}

export function resolveOpenCodeThinkingVariant(
  thinkingMode: ThinkingMode | undefined,
  declaredModes: readonly ThinkingMode[] | undefined,
): string | undefined {
  if (!thinkingMode) return undefined;
  if (thinkingMode === 'none') {
    // A literal none variant disables reasoning where the model offers it;
    // otherwise the provider default already applies without a variant.
    return declaredModes?.includes('none') ? 'none' : undefined;
  }
  if (thinkingMode === 'ultra') {
    // No OpenCode variant maps to ultra; the closest ceiling below it applies.
    if (declaredModes === undefined) return 'max';
    return highestDeclaredMode(declaredModes) ?? undefined;
  }
  if (declaredModes === undefined) return thinkingMode;
  if (declaredModes.includes(thinkingMode)) return thinkingMode;
  // Requests above the model's declared ceiling step down to the highest
  // declared mode, mirroring the Codex max-to-xhigh downgrade contract.
  return highestDeclaredBelow(thinkingMode, declaredModes) ?? undefined;
}

function highestDeclaredMode(declaredModes: readonly ThinkingMode[]): string | undefined {
  return highestDeclaredBelow('ultra', declaredModes);
}

function highestDeclaredBelow(
  ceiling: ThinkingMode,
  declaredModes: readonly ThinkingMode[],
): string | undefined {
  const ceilingIndex = ceiling === 'ultra'
    ? THINKING_MODE_ORDER.length
    : THINKING_MODE_ORDER.indexOf(ceiling);
  for (let index = ceilingIndex - 1; index >= 0; index -= 1) {
    const candidate = THINKING_MODE_ORDER[index];
    if (declaredModes.includes(candidate)) return candidate;
  }
  return undefined;
}
