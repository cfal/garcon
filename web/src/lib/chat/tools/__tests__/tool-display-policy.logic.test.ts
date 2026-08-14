import { describe, it, expect } from 'vitest';
import { resolveDisplayRule, shouldRenderToolResult } from '$lib/chat/tools/tool-display-policy.js';
import type { ToolDisplayRule } from '$lib/chat/tools/tool-display-contract.js';

describe('shouldRenderToolResult', () => {
	it('requires a visible standalone result mode', () => {
		expect(
			shouldRenderToolResult(
				{ input: { mode: 'inline' }, result: { mode: 'collapsible' } },
				{ content: 'data' },
			),
		).toBe(true);
		expect(
			shouldRenderToolResult(
				{ input: { mode: 'inline' }, result: { mode: 'special' } },
				{ content: 'data' },
			),
		).toBe(false);
		expect(
			shouldRenderToolResult(
				{ input: { mode: 'inline' }, result: { mode: 'collapsible', hidden: true } },
				{ content: 'data' },
			),
		).toBe(false);
	});

	it('hides successful results when configured without hiding failures', () => {
		const rule: ToolDisplayRule = {
			input: { mode: 'inline' },
			result: { mode: 'collapsible', hideOnSuccess: true },
		};
		expect(shouldRenderToolResult(rule, { content: 'ok' })).toBe(false);
		expect(shouldRenderToolResult(rule, { content: 'failed', isError: true })).toBe(true);
	});
});

describe('resolveDisplayRule', () => {
	const defaultRule: ToolDisplayRule = {
		input: { mode: 'collapsible', title: 'Parameters' },
	};
	const readRule: ToolDisplayRule = {
		input: { mode: 'inline', label: 'Read' },
		result: { hidden: true },
	};
	const registry: Record<string, ToolDisplayRule> = {
		'read-tool-use': readRule,
		default: defaultRule,
	};

	it('returns the matching rule for a known tool', () => {
		expect(resolveDisplayRule(registry, 'read-tool-use')).toBe(readRule);
	});

	it('falls back to Default for an unknown tool', () => {
		expect(resolveDisplayRule(registry, 'SomeUnknownTool')).toBe(defaultRule);
	});

	it('returns Default for an empty tool name', () => {
		expect(resolveDisplayRule(registry, '')).toBe(defaultRule);
	});
});
