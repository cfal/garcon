import { describe, it, expect } from 'vitest';
import { AgentSwitchMessage, parseChatMessage, parseChatMessages } from '$shared/chat-types';

const TS = '2026-03-01T00:00:00.000Z';

describe('AgentSwitchMessage serialization round-trip', () => {
	it('preserves agent ids and models', () => {
		const msg = new AgentSwitchMessage(TS, 'codex', 'claude', 'gpt-5.5', 'claude-sonnet-4-6');
		const parsed = parseChatMessage(JSON.parse(JSON.stringify(msg)));
		expect(parsed).toBeInstanceOf(AgentSwitchMessage);
		const boundary = parsed as AgentSwitchMessage;
		expect(boundary.type).toBe('agent-switch');
		expect(boundary.fromAgentId).toBe('codex');
		expect(boundary.toAgentId).toBe('claude');
		expect(boundary.fromModel).toBe('gpt-5.5');
		expect(boundary.toModel).toBe('claude-sonnet-4-6');
	});

	it('omits absent models', () => {
		const parsed = parseChatMessage({
			type: 'agent-switch',
			timestamp: TS,
			fromAgentId: 'claude',
			toAgentId: 'codex',
		}) as AgentSwitchMessage;
		expect(parsed.fromModel).toBeUndefined();
		expect(parsed.toModel).toBeUndefined();
	});

	it('survives parseChatMessages alongside other message types', () => {
		const raw = JSON.parse(
			JSON.stringify([
				{ type: 'user-message', timestamp: TS, content: 'hello' },
				new AgentSwitchMessage(TS, 'codex', 'claude'),
			]),
		);
		const messages = parseChatMessages(raw);
		expect(messages.map((m) => m.type)).toEqual(['user-message', 'agent-switch']);
	});
});
