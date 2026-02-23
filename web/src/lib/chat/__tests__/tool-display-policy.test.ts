import { describe, it, expect } from 'vitest';
import { shouldHideToolResult, resolveDisplayRule } from '../tool-display-policy';
import type { ToolDisplayRule } from '../tool-display-contract';

describe('shouldHideToolResult', () => {
	it('returns false when no result rule is defined', () => {
		const rule: ToolDisplayRule = {
			input: { mode: 'inline' },
		};
		expect(shouldHideToolResult(rule, { content: 'ok' })).toBe(false);
	});

	it('returns true when result.hidden is true', () => {
		const rule: ToolDisplayRule = {
			input: { mode: 'inline' },
			result: { hidden: true },
		};
		expect(shouldHideToolResult(rule, { content: 'ok' })).toBe(true);
	});

	it('returns true when result.hideOnSuccess is true and result is not an error', () => {
		const rule: ToolDisplayRule = {
			input: { mode: 'inline' },
			result: { hideOnSuccess: true },
		};
		expect(shouldHideToolResult(rule, { content: 'ok' })).toBe(true);
	});

	it('returns false when result.hideOnSuccess is true but result is an error', () => {
		const rule: ToolDisplayRule = {
			input: { mode: 'inline' },
			result: { hideOnSuccess: true },
		};
		expect(shouldHideToolResult(rule, { content: 'fail', isError: true })).toBe(false);
	});

	it('returns false when result.hideOnSuccess is true but toolResult is null', () => {
		const rule: ToolDisplayRule = {
			input: { mode: 'inline' },
			result: { hideOnSuccess: true },
		};
		expect(shouldHideToolResult(rule, null)).toBe(false);
	});

	it('returns false when result.hideOnSuccess is true but toolResult is undefined', () => {
		const rule: ToolDisplayRule = {
			input: { mode: 'inline' },
			result: { hideOnSuccess: true },
		};
		expect(shouldHideToolResult(rule, undefined)).toBe(false);
	});

	it('returns false when result has neither hidden nor hideOnSuccess', () => {
		const rule: ToolDisplayRule = {
			input: { mode: 'collapsible' },
			result: { mode: 'collapsible' },
		};
		expect(shouldHideToolResult(rule, { content: 'data' })).toBe(false);
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
		Read: readRule,
		Default: defaultRule,
	};

	it('returns the matching rule for a known tool', () => {
		expect(resolveDisplayRule(registry, 'Read')).toBe(readRule);
	});

	it('falls back to Default for an unknown tool', () => {
		expect(resolveDisplayRule(registry, 'SomeUnknownTool')).toBe(defaultRule);
	});

	it('returns Default for an empty tool name', () => {
		expect(resolveDisplayRule(registry, '')).toBe(defaultRule);
	});
});
