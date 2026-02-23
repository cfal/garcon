// Display policy functions for tool rendering. Encapsulates the
// decision logic that determines visibility and rule resolution
// independently of the registry data.

import type { ToolPayload, ToolDisplayRule } from './tool-display-contract';

/** Returns true when the tool result should be hidden from the display. */
export function shouldHideToolResult(
	rule: ToolDisplayRule,
	toolResult: ToolPayload | null | undefined,
): boolean {
	const result = rule.result;
	if (!result) return false;
	if (result.hidden) return true;
	if (result.hideOnSuccess && toolResult && !toolResult.isError) return true;
	return false;
}

/** Resolves the display rule for a given tool name, falling back to Default. */
export function resolveDisplayRule(
	registry: Record<string, ToolDisplayRule>,
	toolName: string,
): ToolDisplayRule {
	return registry[toolName] || registry.Default;
}
