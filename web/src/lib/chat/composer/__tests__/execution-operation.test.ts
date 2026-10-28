import { describe, expect, it } from 'vitest';
import { composerExecutionOperations, isComposerControllerCommand } from '../execution-operation';

const conversationalProvider = { executionPolicy: 'conversation', supportsFork: true } as const;

describe('composer execution operation', () => {
	it('keeps controller-only commands independent of execution support on persisted chats', () => {
		const chat = { status: 'running' } as const;
		expect(isComposerControllerCommand(chat, '/clear', null)).toBe(true);
		expect(isComposerControllerCommand(chat, '/rename Synthetic title', 'conversation')).toBe(true);
		expect(isComposerControllerCommand(chat, '/rename Synthetic title', null)).toBe(false);
		expect(isComposerControllerCommand(chat, '/compact', 'conversation')).toBe(false);
		expect(isComposerControllerCommand(chat, 'Synthetic input', 'literal')).toBe(false);
		expect(isComposerControllerCommand({ status: 'draft' }, '/clear', 'conversation')).toBe(false);
		expect(isComposerControllerCommand(null, '/clear', null)).toBe(false);
	});

	it.each([undefined, null, { status: 'draft', hasAgentSession: false },
		{ status: 'running', hasAgentSession: false }] as const)('starts chats without a native session: %j', chat => {
		expect(composerExecutionOperations(chat, 'Synthetic prompt', conversationalProvider)).toEqual(['execution.start']);
	});

	it('resumes only established sessions and selects compaction independently', () => {
		const chat = { status: 'running', hasAgentSession: true } as const;
		expect(composerExecutionOperations(chat, 'Synthetic prompt', conversationalProvider)).toEqual(['execution.resume']);
		expect(composerExecutionOperations(chat, '/compact', conversationalProvider)).toEqual(['compaction.compact']);
		expect(composerExecutionOperations(chat, '/compact Synthetic instructions', conversationalProvider)).toEqual(['compaction.compact']);
		expect(composerExecutionOperations(chat, '/handoff Synthetic prompt', conversationalProvider)).toEqual(['execution.start']);
		expect(composerExecutionOperations(chat, '/fork Synthetic prompt', conversationalProvider)).toEqual(['execution.start', 'execution.resume']);
		expect(composerExecutionOperations(chat, '/fork', conversationalProvider)).toEqual([]);
		expect(composerExecutionOperations({ ...chat, hasAgentSession: false }, '/fork ', conversationalProvider)).toEqual([]);
		expect(composerExecutionOperations({ status: 'draft', hasAgentSession: false }, '/fork', conversationalProvider)).toEqual(['execution.start']);
		expect(composerExecutionOperations(chat, '/compact', { ...conversationalProvider, executionPolicy: 'literal' })).toEqual(['execution.resume']);
		expect(composerExecutionOperations({ status: 'draft', hasAgentSession: false }, '/compact', conversationalProvider)).toEqual(['execution.start']);
	});

	it.each([false, true])('treats unsupported fork commands as ordinary execution, native=%s', hasAgentSession => {
		const provider = { ...conversationalProvider, supportsFork: false };
		for (const text of ['/fork', '/fork Synthetic input']) {
			expect(composerExecutionOperations({ status: 'running', hasAgentSession }, text, provider))
				.toEqual([hasAgentSession ? 'execution.resume' : 'execution.start']);
		}
	});
});
