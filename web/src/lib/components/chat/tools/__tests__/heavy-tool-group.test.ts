import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { expect, it, vi } from 'vitest';
import {
	BashToolUseMessage,
	EditToolUseMessage,
	ExecToolUseMessage,
	ReadToolUseMessage,
	ToolResultMessage,
} from '$shared/chat-types';
import { ActiveTranscriptState } from '$lib/chat/transcript/active-transcript-state.svelte';
import { seedTranscript } from '$lib/chat/transcript/__tests__/transcript-fixture';
import { installResizeObserverHarness } from '$lib/components/shared/__tests__/resize-observer-harness';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';
import ConversationFeedTestHost from '../../transcript/__tests__/ConversationFeedTestHost.svelte';
import * as diffs from '../content/chat-tool-diff';

it('keeps grouped code and result payloads out of the collapsed DOM and discloses the exact edit', async () => {
	const restoreObserver = installResizeObserverHarness();
	const settingsKey = LOCAL_STORAGE_KEYS.localSettings;
	const previous = localStorage.getItem(settingsKey);
	try {
		vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(720);
		vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(80);
		const buildDiff = vi.spyOn(diffs, 'buildChatToolDiff');
		localStorage.setItem(
			settingsKey,
			JSON.stringify({ combineToolUseMessages: true, autoExpandTools: false }),
		);
		const at = '2026-01-01T00:00:00Z';
		const lines = Array.from(
			{ length: 450 },
			(_, i) => `const component${i} = makeComponent(${i});`,
		);
		const oldCode = lines.join('\n');
		const changed = 'const component225 = makeComponent(1000);';
		const newCode = lines.with(225, changed).join('\n');
		const command = Array.from({ length: 64 }, (_, i) => `printf '%s\\n' segment-${i}`).join('\n');
		const rows = [
			new BashToolUseMessage(at, 'command', command),
			new ToolResultMessage(at, 'command', { raw: oldCode }, false),
			new ReadToolUseMessage(at, 'read', '/project/example.ts', 1, 450),
			new ToolResultMessage(at, 'read', { raw: oldCode }, false),
			new ExecToolUseMessage(at, 'run-code', oldCode, 'javascript'),
			new EditToolUseMessage(at, 'edit', '/project/example.ts', oldCode, newCode),
		];
		const transcript = new ActiveTranscriptState();
		const entries = rows.map((message, index) => ({ ordinal: index + 1, message }));
		seedTranscript(transcript, 'chat-1', 'generation-1', entries, {
			lastOrdinal: rows.length,
			pageOldestOrdinal: 1,
			nextBeforeOrdinal: null,
			hasMore: false,
		});
		const { container, findByRole, getByRole } = render(ConversationFeedTestHost, { transcript });
		const group = await findByRole('button', {
			name: 'Execute 2 commands, read a file, edit a file',
		});
		expect(
			container.querySelectorAll('[data-chat-row-id], [data-slot="chat-event-card"]'),
		).toHaveLength(0);
		expect(group.getAttribute('aria-expanded')).toBe('false');
		expect(buildDiff).not.toHaveBeenCalled();

		await fireEvent.click(group);
		await waitFor(() =>
			expect(
				Array.from(
					container.querySelectorAll<HTMLElement>('[data-chat-row-id]'),
					(row) => row.dataset.chatRowId,
				),
			).toEqual(['generation-1:1', 'generation-1:3', 'generation-1:5', 'generation-1:6']),
		);
		expect(container.querySelector('[data-chat-bash-command]')?.textContent).toBe(`$ ${command}`);
		expect(
			container.querySelector('[data-chat-message-type="exec-tool-use"] code')?.textContent?.trim(),
		).toBe(oldCode);
		expect(buildDiff).not.toHaveBeenCalled();
		await fireEvent.click(getByRole('button', { name: 'Expand' }));
		await waitFor(() => expect(buildDiff).toHaveBeenCalledTimes(1));
		const changedLines = container.querySelectorAll(
			'.typography-code-diff > div > span:last-child',
		);
		expect(Array.from(changedLines, (line) => line.textContent)).toEqual([lines[225], changed]);
		await fireEvent.click(group);
		expect(group.getAttribute('aria-expanded')).toBe('false');
		expect(container.querySelectorAll('[data-chat-row-id]')).toHaveLength(0);
		expect(transcript.entries).toEqual(entries);
	} finally {
		cleanup();
		vi.restoreAllMocks();
		if (previous === null) localStorage.removeItem(settingsKey);
		else localStorage.setItem(settingsKey, previous);
		restoreObserver();
	}
});
