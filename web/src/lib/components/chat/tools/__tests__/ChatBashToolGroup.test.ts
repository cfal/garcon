import { render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { BashToolUseMessage } from '$shared/chat-types';
import ChatBashToolGroup from '../ChatBashToolGroup.svelte';

const TS = '2026-07-10T00:00:00.000Z';

describe('ChatBashToolGroup', () => {
	it('highlights every command without changing the grouped row layout', async () => {
		const commands = [
			'if true; then echo "ready"; fi',
			'for item in one two; do echo "$item"; done',
		];
		const { container } = render(ChatBashToolGroup, {
			messages: commands.map(
				(command, index) => new BashToolUseMessage(TS, `bash-${index}`, command),
			),
		});

		expect(screen.getByText('2 commands')).toBeTruthy();
		const codeRows = Array.from(container.querySelectorAll('code.code-highlight'));
		expect(codeRows).toHaveLength(2);
		expect(codeRows.map((row) => row.textContent)).toEqual(commands);
		expect(container.querySelector('.markdown-code-block')).toBeNull();
		expect(container.querySelector('pre')).toBeNull();

		for (const row of codeRows) {
			expect(row.classList.contains('block')).toBe(true);
			expect(row.classList.contains('whitespace-pre-wrap')).toBe(true);
			expect(row.classList.contains('break-all')).toBe(true);
		}

		await waitFor(
			() => {
				for (const row of codeRows) {
					expect(row.querySelector('.cm-code-keyword')).toBeTruthy();
					expect(row.querySelector('.cm-code-string')).toBeTruthy();
				}
			},
			{ timeout: 5_000 },
		);
		expect(codeRows.map((row) => row.textContent)).toEqual(commands);
	});
});
