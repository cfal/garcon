import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { AssistantMessage } from '$shared/chat-types';
import { composerQuestion } from '$lib/chat/composer/composer-question.js';
import ConversationMessageHost from './ConversationMessageHost.svelte';

afterEach(cleanup);

describe('question dock transcript presentation', () => {
	it('removes only recognized options while docked and restores them on dismissal', async () => {
		const content = 'Which format do you prefer?\n- Short outline\n- Detailed example\n\nChoose one option.';
		const message = new AssistantMessage('2026-01-01T00:00:00Z', content);
		const dockedQuestion = composerQuestion([{ ordinal: 4, message }], [], {
			isProcessing: false, hasLaterMessages: false,
		});
		expect(dockedQuestion?.kind).toBe('plain');
		const rendered = render(ConversationMessageHost, { message, forkUpToSeq: 4, dockedQuestion });
		expect(screen.getByText('Which format do you prefer?')).toBeTruthy();
		expect(screen.queryByText('Short outline')).toBeNull();
		expect(screen.queryByText('Detailed example')).toBeNull();
		expect(message.content).toBe(content);
		await rendered.rerender({ message, forkUpToSeq: 4, dockedQuestion: null });
		expect(screen.getByText('Short outline')).toBeTruthy();
		expect(screen.getByText('Detailed example')).toBeTruthy();
	});

	it('does not hide identical choices at a different transcript address', () => {
		const message = new AssistantMessage('2026-01-01T00:00:00Z', 'Which format do you prefer?\n- Outline\n- Diagram');
		const dockedQuestion = composerQuestion([{ ordinal: 4, message }], [], {
			isProcessing: false, hasLaterMessages: false,
		});
		render(ConversationMessageHost, { message, forkUpToSeq: 2, dockedQuestion });
		expect(screen.getByText('Outline')).toBeTruthy();
		expect(screen.getByText('Diagram')).toBeTruthy();
	});

	it('keeps structured async question prompts without their duplicate choices', () => {
		const message = new AssistantMessage('2026-01-01T00:00:00Z', 'Synthetic question', {
			id: 'set-1', questions: [{ id: 'mode', prompt: 'Which mode?', allowFreeText: true,
				options: [{ id: 'fast', label: 'Fast' }, { id: 'careful', label: 'Careful' }] }],
		});
		render(ConversationMessageHost, { message, forkUpToSeq: 3,
			dockedQuestion: { kind: 'async', ordinal: 3, message } });
		expect(screen.getByText('Which mode?')).toBeTruthy();
		expect(screen.queryByText('Fast')).toBeNull();
		expect(screen.queryByText('Careful')).toBeNull();
	});
});
