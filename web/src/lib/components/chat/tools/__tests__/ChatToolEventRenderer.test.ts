import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import ChatToolEventRenderer from '../ChatToolEventRenderer.svelte';
import {
	EditToolUseMessage,
	ExitPlanModeToolUseMessage,
	GlobToolUseMessage,
	GrepToolUseMessage,
	WebFetchToolUseMessage,
	WriteStdinToolUseMessage,
} from '$shared/chat-types';

describe('ChatToolEventRenderer', () => {
	it('keeps Edit collapsed when autoExpandTools is disabled and defaultOpen is false', () => {
		render(ChatToolEventRenderer, {
			toolMessage: new EditToolUseMessage('', 'tool-1', '/tmp/example.ts', 'const a = 1;', 'const a = 2;'),
			mode: 'input',
			autoExpandTools: false
		});

		expect(screen.queryByText('const a = 2;')).toBeNull();
	});

	it('opens tools with defaultOpen=true when autoExpandTools is disabled', () => {
		render(ChatToolEventRenderer, {
			toolMessage: new ExitPlanModeToolUseMessage('', 'tool-2', 'Implement the migration.'),
			mode: 'input',
			autoExpandTools: false
		});

		expect(screen.getByText('Implement the migration.')).toBeTruthy();
	});

	it('forces Edit open when autoExpandTools is enabled even with defaultOpen=false', () => {
		render(ChatToolEventRenderer, {
			toolMessage: new EditToolUseMessage('', 'tool-3', '/tmp/example.ts', 'const a = 1;', 'const a = 2;'),
			mode: 'input',
			autoExpandTools: true
		});

		expect(screen.getByText('const a = 2;')).toBeTruthy();
	});

	it('renders streaming Edit without diff as non-expandable single row', () => {
		const onFileOpen = () => {};
		render(ChatToolEventRenderer, {
			toolMessage: new EditToolUseMessage('', 'tool-4', undefined, undefined, undefined, [{ path: '/tmp/ChatEventCard.svelte', kind: 'update' }]),
			mode: 'input',
			onFileOpen
		});

		expect(screen.getByRole('button', { name: 'ChatEventCard.svelte' })).toBeTruthy();
		expect(screen.queryByText('Changed files')).toBeNull();
	});

	it('renders Grep input without jump-to-results affordance', () => {
		render(ChatToolEventRenderer, {
			toolMessage: new GrepToolUseMessage('', 'tool-5', 'border-dotted', '/tmp/ChatEventCard.svelte'),
			mode: 'input'
		});

		expect(screen.getByText('Pattern')).toBeTruthy();
		expect(screen.getByText('border-dotted')).toBeTruthy();
		expect(screen.queryByLabelText('Jump to results')).toBeNull();
	});

	it('renders WebFetch as url + instruction details without jump affordance', () => {
		render(ChatToolEventRenderer, {
			toolMessage: new WebFetchToolUseMessage('', 'tool-6', 'https://example.com/spec', 'Extract the API version.'),
			mode: 'input'
		});

		expect(screen.getByText('WebFetch')).toBeTruthy();
		expect(screen.getByText('https://example.com/spec')).toBeTruthy();
		expect(screen.getByText('Instruction: Extract the API version.')).toBeTruthy();
		expect(screen.queryByLabelText('Jump to results')).toBeNull();
	});

	it('suppresses WriteStdin rows entirely', () => {
		render(ChatToolEventRenderer, {
			toolMessage: new WriteStdinToolUseMessage('', 'tool-7', {
				session_id: 123,
				yield_time_ms: 30000,
				max_output_tokens: 4000
			}),
			mode: 'input'
		});

		expect(screen.queryByText('WriteStdin')).toBeNull();
		expect(screen.queryByText('123')).toBeNull();
	});
});

describe('tool result and jump behavior', () => {
	it('renders jump-to-results link for Glob when toolResult is present', () => {
		const toolResult = {
			content: { filenames: ['a.ts', 'b.ts'], numFiles: 2 }
		};
		render(ChatToolEventRenderer, {
			toolMessage: new GlobToolUseMessage('', 'tool-glob-1', '**/*.ts'),
			toolResult,
			mode: 'input'
		});

		const jumpLink = screen.getByLabelText('Jump to results');
		expect(jumpLink).toBeTruthy();
		expect(jumpLink.getAttribute('href')).toBe('#tool-result-tool-glob-1');
	});

	it('does not render jump link for Glob when toolResult is absent', () => {
		render(ChatToolEventRenderer, {
			toolMessage: new GlobToolUseMessage('', 'tool-glob-2', '**/*.ts'),
			mode: 'input'
		});

		expect(screen.queryByLabelText('Jump to results')).toBeNull();
	});

	it('renders result section with anchor id for Glob tool result', () => {
		const toolResult = {
			content: { filenames: ['src/a.ts', 'src/b.ts'], numFiles: 2 }
		};
		const { container } = render(ChatToolEventRenderer, {
			toolMessage: new GlobToolUseMessage('', 'tool-glob-3', '**/*.ts'),
			toolResult,
			mode: 'input'
		});

		const anchor = container.querySelector('#tool-result-tool-glob-3');
		expect(anchor).toBeTruthy();
	});

	it('renders result title derived from tool result data', () => {
		const toolResult = {
			content: { filenames: ['one.ts'], numFiles: 1 }
		};
		render(ChatToolEventRenderer, {
			toolMessage: new GlobToolUseMessage('', 'tool-glob-4', '*.ts'),
			toolResult,
			mode: 'input',
			autoExpandTools: true
		});

		expect(screen.getByText('Found 1 file')).toBeTruthy();
	});

	it('renders plural file count in result title', () => {
		const toolResult = {
			content: { filenames: ['a.ts', 'b.ts', 'c.ts'], numFiles: 3 }
		};
		render(ChatToolEventRenderer, {
			toolMessage: new GlobToolUseMessage('', 'tool-glob-5', '*.ts'),
			toolResult,
			mode: 'input',
			autoExpandTools: true
		});

		expect(screen.getByText('Found 3 files')).toBeTruthy();
	});
});
