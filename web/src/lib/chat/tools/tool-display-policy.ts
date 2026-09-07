// Display policy functions for tool rendering. Encapsulates the
// decision logic that determines visibility and rule resolution
// independently of the registry data.

import type { ToolPayload, ToolDisplayRule } from '$lib/chat/tools/tool-display-contract.js';

export function shouldRenderToolResult(
	rule: ToolDisplayRule,
	toolResult: ToolPayload | null | undefined,
): boolean {
	const result = rule.result;
	if (!result || result.hidden) return false;
	if (result.hideOnSuccess && toolResult && !toolResult.isError) return false;
	const mode = result.mode;
	return mode === 'inline' || mode === 'collapsible';
}

/** Resolves the display rule for a given tool type, falling back to default. */
export function resolveDisplayRule(
	registry: Record<string, ToolDisplayRule>,
	toolType: string,
): ToolDisplayRule {
	return registry[toolType] || registry.default;
}
