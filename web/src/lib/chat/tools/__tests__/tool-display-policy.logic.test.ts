import { describe, it, expect } from 'vitest';
import { resolveDisplayRule, shouldRenderToolResult } from '$lib/chat/tools/tool-display-policy.js';
import type { ToolDisplayRule } from '$lib/chat/tools/tool-display-contract.js';
import { BashToolUseMessage, EditToolUseMessage, ExecToolUseMessage, ReadToolUseMessage, WriteToolUseMessage } from '$shared/chat-types';

describe('shouldRenderToolResult', () => {
	it('hides empty success envelopes but keeps failures, attachments and explicit structured values', () => {
		const rule: ToolDisplayRule = { input: { mode: 'inline' }, result: { mode: 'collapsible' } };
		const wrapped = { type: 'content', content: { type: 'text', text: '\t' } };
		for (const content of [{}, { raw: ' \n' }, { items: [] }, { content: [wrapped.content] }, { items: [wrapped] }]) {
			expect(shouldRenderToolResult(rule, { content })).toBe(false);
			expect(shouldRenderToolResult(rule, { content, isError: true })).toBe(true);
		}
		for (const content of [{ raw: '0' }, { count: 0 }, { rawOutput: 0 }, { rawOutput: false },
			{ items: [{ type: 'image' }] }, { content: [{ type: 'text', text: '', annotations: {} }] },
			{ items: [{ ...wrapped, annotations: {} }] }, { content: [], structuredContent: { count: 0 } }]) {
			expect(shouldRenderToolResult(rule, { content })).toBe(true);
		}
	});

	it.each([
		{ hidden: true },
		{ mode: 'special' as const },
		{ hideOnSuccess: true },
		{ mode: 'collapsible' as const, contentKind: 'fileList' as const },
	])('keeps rejected empty canonical calls renderable despite their success policy: %j', (result) => {
		for (const tool of [new BashToolUseMessage('', 'invalid', ''), new ReadToolUseMessage('', 'invalid', ''), new WriteToolUseMessage('', 'invalid', ''), new EditToolUseMessage('', 'invalid', ''), new ExecToolUseMessage('', 'invalid', '', 'javascript'), new ExecToolUseMessage('', 'invalid', '', 'powershell')]) {
			expect(shouldRenderToolResult({ input: { mode: 'inline' }, result }, {
				content: { raw: 'Invalid arguments' }, isError: true,
			}, tool)).toBe(true);
		}
	});

	it('preserves ordinary failure and permission-denial suppression for populated inputs', () => {
		for (const tool of [new BashToolUseMessage('', 'normal', 'rg missing'), new ReadToolUseMessage('', 'normal', 'file'), new WriteToolUseMessage('', 'normal', 'file'), new EditToolUseMessage('', 'normal', 'file'), new EditToolUseMessage('', 'dynamic'), new ExecToolUseMessage('', 'normal', 'text(1)', 'javascript'), new ExecToolUseMessage('', 'normal', 'Write-Output 1', 'powershell')]) {
			expect(shouldRenderToolResult({ input: { mode: 'inline' }, result: { hidden: true } }, {
				content: { raw: 'Denied by user' }, isError: true,
			}, tool)).toBe(false);
		}
	});

	it('retains explicit hidden-tool policy for failures', () => {
		expect(shouldRenderToolResult({ input: { mode: 'hidden' }, result: { hidden: true } }, {
			content: { raw: 'failed' }, isError: true,
		})).toBe(false);
	});

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
