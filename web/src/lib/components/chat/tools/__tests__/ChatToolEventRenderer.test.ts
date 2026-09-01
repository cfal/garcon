import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import ChatToolEventRenderer from '../ChatToolEventRenderer.svelte';
import type { ConversationDisclosureStatePort } from '../../ConversationFeedItemState.svelte.js';
import {
	AmpFinderToolUseMessage,
	AmpOracleToolUseMessage,
	AmpTaskListToolUseMessage,
	BashToolUseMessage,
	CodexSubagentToolUseMessage,
	EditToolUseMessage,
	ExecToolUseMessage,
	WaitToolUseMessage,
	ExitPlanModeToolUseMessage,
	GlobToolUseMessage,
	GrepToolUseMessage,
	UnknownToolUseMessage,
	WebFetchToolUseMessage,
	WriteStdinToolUseMessage,
} from '$shared/chat-types';

beforeAll(async () => {
	const { highlightCodeFence } = await import('$lib/highlighting/code-fence-highlighter');
	await highlightCodeFence('{"ready": true}', 'json');
});

describe('ChatToolEventRenderer', () => {
	it('keeps Edit collapsed when autoExpandTools is disabled and defaultOpen is false', () => {
		render(ChatToolEventRenderer, {
			toolMessage: new EditToolUseMessage(
				'',
				'tool-1',
				'/tmp/example.ts',
				'const a = 1;',
				'const a = 2;',
			),
			mode: 'input',
			autoExpandTools: false,
		});

		expect(screen.queryByText('const a = 2;')).toBeNull();
	});

	it('opens tools with defaultOpen=true when autoExpandTools is disabled', () => {
		render(ChatToolEventRenderer, {
			toolMessage: new ExitPlanModeToolUseMessage('', 'tool-2', 'Implement the change.'),
			mode: 'input',
			autoExpandTools: false,
		});

		expect(screen.getByText('Implement the change.')).toBeTruthy();
	});

	it('passes rich markdown file link hrefs to the file-open callback', async () => {
		const onFileOpen = vi.fn();
		render(ChatToolEventRenderer, {
			toolMessage: new ExitPlanModeToolUseMessage(
				'',
				'tool-rich-link',
				'Open [readme](/workspace/other/README.md)',
			),
			mode: 'input',
			autoExpandTools: false,
			onFileOpen,
			projectBasePath: '/workspace',
			chatProjectPath: '/workspace/current',
		});

		await fireEvent.click(screen.getByRole('link', { name: 'readme' }));

		expect(onFileOpen).toHaveBeenCalledWith('/workspace/other/README.md');
	});

	it('forces Edit open when autoExpandTools is enabled even with defaultOpen=false', () => {
		render(ChatToolEventRenderer, {
			toolMessage: new EditToolUseMessage(
				'',
				'tool-3',
				'/tmp/example.ts',
				'const a = 1;',
				'const a = 2;',
			),
			mode: 'input',
			autoExpandTools: true,
		});

		expect(screen.getByText('const a = 2;')).toBeTruthy();
	});

	it('elides an expanded Edit whose diff exceeds the work budget', () => {
		const oldContent = Array.from({ length: 501 }, (_, index) => `old-${index}`).join('\n');
		const newContent = Array.from({ length: 501 }, (_, index) => `new-${index}`).join('\n');
		render(ChatToolEventRenderer, {
			toolMessage: new EditToolUseMessage(
				'',
				'tool-large-diff',
				'/tmp/example.ts',
				oldContent,
				newContent,
			),
			mode: 'input',
			autoExpandTools: true,
		});

		expect(screen.getByText('Changes are too large to render inline.')).toBeTruthy();
		expect(screen.queryByText('old-500')).toBeNull();
	});

	it('delegates controlled disclosure changes to the virtual row owner', async () => {
		const disclosureState = {
			open: vi.fn(() => true),
			setOpen: vi.fn(),
		} satisfies ConversationDisclosureStatePort;
		render(ChatToolEventRenderer, {
			toolMessage: new EditToolUseMessage(
				'',
				'tool-controlled',
				'/tmp/example.ts',
				'const a = 1;',
				'const a = 2;',
			),
			mode: 'input',
			disclosureState,
		});

		const trigger = screen.getByRole('button', { name: /example\.ts/i });
		expect(trigger.getAttribute('aria-expanded')).toBe('true');
		await fireEvent.click(trigger);
		expect(disclosureState.setOpen).toHaveBeenCalledWith(
			'tool-input',
			'tool-controlled',
			false,
			false,
		);
	});

	it('renders streaming Edit without diff as non-expandable single row', () => {
		const onFileOpen = () => {};
		render(ChatToolEventRenderer, {
			toolMessage: new EditToolUseMessage('', 'tool-4', undefined, undefined, undefined, [
				{ path: '/tmp/ChatEventCard.svelte', kind: 'update' },
			]),
			mode: 'input',
			onFileOpen,
		});

		expect(screen.getByRole('button', { name: 'ChatEventCard.svelte' })).toBeTruthy();
		expect(screen.queryByText('Changed files')).toBeNull();
	});

	it('renders Grep input without jump-to-results affordance', () => {
		render(ChatToolEventRenderer, {
			toolMessage: new GrepToolUseMessage(
				'',
				'tool-5',
				'border-dotted',
				'/tmp/ChatEventCard.svelte',
			),
			mode: 'input',
		});

		expect(screen.getByText('Pattern')).toBeTruthy();
		expect(screen.getByText('border-dotted')).toBeTruthy();
		expect(screen.queryByLabelText('Jump to results')).toBeNull();
	});

	it('renders WebFetch as url + instruction details without jump affordance', () => {
		render(ChatToolEventRenderer, {
			toolMessage: new WebFetchToolUseMessage(
				'',
				'tool-6',
				'https://example.com/spec',
				'Extract the API version.',
			),
			mode: 'input',
		});

		expect(screen.getByText('WebFetch')).toBeTruthy();
		expect(screen.getByText('https://example.com/spec')).toBeTruthy();
		expect(screen.getByText('Instruction: Extract the API version.')).toBeTruthy();
		expect(screen.queryByLabelText('Jump to results')).toBeNull();
	});

	it('renders AmpFinder as a typed inline search event', () => {
		render(ChatToolEventRenderer, {
			toolMessage: new AmpFinderToolUseMessage('', 'tool-finder-1', 'find auth handlers'),
			mode: 'input',
		});

		expect(screen.getByText('Search')).toBeTruthy();
		expect(screen.getByText('find auth handlers')).toBeTruthy();
	});

	it('renders AmpOracle as a typed collapsible event', () => {
		render(ChatToolEventRenderer, {
			toolMessage: new AmpOracleToolUseMessage(
				'',
				'tool-oracle-1',
				'Review auth flow',
				'Focus on websocket permissions',
				['src/auth.ts'],
			),
			mode: 'input',
			autoExpandTools: true,
		});

		expect(screen.getByText('Task:')).toBeTruthy();
		expect(screen.getByText('Review auth flow')).toBeTruthy();
		expect(screen.getByText('Context:')).toBeTruthy();
	});

	it('renders AmpTaskList using its typed task summary', () => {
		render(ChatToolEventRenderer, {
			toolMessage: new AmpTaskListToolUseMessage(
				'',
				'tool-task-list-1',
				'update',
				'42',
				'Ship implementation',
				'done',
			),
			mode: 'input',
		});

		expect(screen.getByText('Tasks')).toBeTruthy();
		expect(screen.getByText('updating #42')).toBeTruthy();
	});

	it('renders Codex subagent tools as typed collapsible events', () => {
		const { container } = render(ChatToolEventRenderer, {
			toolMessage: new CodexSubagentToolUseMessage('', 'tool-codex-subagent-1', 'spawn_agent', {
				taskName: 'review-auth',
				message: 'Review auth boundaries',
				model: 'gpt-5.5',
			}),
			mode: 'input',
			autoExpandTools: true,
		});

		expect(screen.getByText('Subagent')).toBeTruthy();
		expect(screen.getByText('Spawn agent: review-auth')).toBeTruthy();
		expect(screen.getByText('Action:')).toBeTruthy();
		expect(screen.getByText('Review auth boundaries')).toBeTruthy();
		expect(container.querySelector('#tool-input-tool-codex-subagent-1')).toBeTruthy();
	});

	it('suppresses WriteStdin rows entirely', () => {
		const { container } = render(ChatToolEventRenderer, {
			toolMessage: new WriteStdinToolUseMessage('', 'tool-7', {
				session_id: 123,
				yield_time_ms: 30000,
				max_output_tokens: 4000,
			}),
			mode: 'input',
		});

		expect(screen.queryByText('WriteStdin')).toBeNull();
		expect(screen.queryByText('123')).toBeNull();
		expect(container.childElementCount).toBe(0);
	});

	it('suppresses Wait rows and paired results entirely', () => {
		const { container } = render(ChatToolEventRenderer, {
			toolMessage: new WaitToolUseMessage('', 'tool-wait', '46', 30000, 12000),
			toolResult: { content: { raw: 'Script completed' }, isError: false },
			mode: 'input',
		});

		expect(screen.queryByText('Wait')).toBeNull();
		expect(screen.queryByText('Script completed')).toBeNull();
		expect(container.childElementCount).toBe(0);
	});

	it('renders Bash as a highlighted shell command on the shared card surface', async () => {
		const command = 'if true; then echo "ready"; fi';
		const { container } = render(ChatToolEventRenderer, {
			toolMessage: new BashToolUseMessage('', 'bash-1', command),
			mode: 'input',
		});

		const code = container.querySelector('code.code-highlight');
		expect(code?.textContent).toBe(`$ ${command}`);
		expect(code?.classList.contains('text-xs')).toBe(true);
		expect(code?.classList.contains('font-mono')).toBe(true);
		expect(code?.classList.contains('block')).toBe(true);
		expect(code?.classList.contains('leading-[1.25]')).toBe(true);
		expect(code?.classList.contains('whitespace-pre-wrap')).toBe(true);
		expect(code?.classList.contains('break-all')).toBe(true);
		expect(code?.querySelector('span')?.classList.contains('w-5')).toBe(true);

		const card = code?.closest('article');
		expect(card?.classList.contains('rounded-xl')).toBe(true);
		expect(card?.classList.contains('border')).toBe(true);
		expect(card?.classList.contains('shadow-sm')).toBe(true);
		expect(card?.classList.contains('bg-chat-bash-row')).toBe(true);
		expect(card?.classList.contains('px-3')).toBe(true);
		expect(card?.classList.contains('py-2')).toBe(true);
		expect(container.querySelector('.markdown-code-block')).toBeNull();
		expect(container.querySelector('pre')).toBeNull();
		expect(container.querySelector('button')).toBeNull();
		expect(screen.queryByText('Bash')).toBeNull();
		expect(container.children).toHaveLength(1);
		expect(container.firstElementChild?.classList.contains('my-0.5')).toBe(true);

		await waitFor(
			() => {
				expect(code?.querySelector('.cm-code-keyword')).toBeTruthy();
				expect(code?.querySelector('.cm-code-string')).toBeTruthy();
			},
			{ timeout: 5_000 },
		);
		expect(code?.textContent).toBe(`$ ${command}`);
	});

	it('highlights unknown tool inputs as JSON within the existing details view', async () => {
		const { container } = render(ChatToolEventRenderer, {
			toolMessage: new UnknownToolUseMessage('', 'unknown-1', 'custom_tool', {
				path: '/tmp/example',
				recursive: true,
			}),
			mode: 'input',
			autoExpandTools: true,
		});

		const code = container.querySelector('pre.code-highlight');
		expect(code?.textContent).toContain('"path": "/tmp/example"');
		expect(code?.classList.contains('p-2')).toBe(true);
		expect(code?.classList.contains('whitespace-pre-wrap')).toBe(true);

		await waitFor(
			() => {
				expect(code?.querySelector('.cm-code-string')).toBeTruthy();
			},
			{ timeout: 5_000 },
		);
	});

	it('always renders wrapped Exec source inline with its language label', async () => {
		const code = 'const value = 1 < 2;';
		const { container } = render(ChatToolEventRenderer, {
			toolMessage: new ExecToolUseMessage('', 'exec-1', code, 'javascript'),
			mode: 'input',
			autoExpandTools: false,
		});

		expect(screen.getByText('Exec javascript')).toBeTruthy();
		expect(screen.queryByText('Code')).toBeNull();
		expect(container.querySelector('.markdown-code-block')).toBeNull();
		expect(container.querySelector('pre')).toBeNull();

		const codeElement = container.querySelector('code.code-highlight');
		expect(codeElement?.textContent).toBe(code);
		expect(container.querySelector('#tool-body-exec-1')).toBeNull();
		expect(codeElement?.classList.contains('whitespace-pre-wrap')).toBe(true);
		expect(codeElement?.classList.contains('break-all')).toBe(true);
		await waitFor(
			() => {
				expect(codeElement?.querySelector('.cm-code-keyword')).toBeTruthy();
			},
			{ timeout: 5_000 },
		);
	});

	it('does not render a generic result card for Exec special results', () => {
		const { container } = render(ChatToolEventRenderer, {
			toolMessage: new ExecToolUseMessage('', 'exec-2', 'text("ok")', 'javascript'),
			toolResult: { content: { raw: 'ok' }, isError: false },
			mode: 'input',
			autoExpandTools: false,
		});

		expect(container.querySelector('#tool-result-exec-2')).toBeNull();
		expect(screen.queryByText('ok')).toBeNull();
	});
});

describe('tool result and jump behavior', () => {
	it('renders jump-to-results link for Glob when toolResult is present', () => {
		const toolResult = {
			content: { filenames: ['a.ts', 'b.ts'], numFiles: 2 },
		};
			render(ChatToolEventRenderer, {
				toolMessage: new GlobToolUseMessage('', 'tool-glob-1', '**/*.ts'),
				toolResult,
				mode: 'input',
				resultAnchorId: 'tool-result-generation-1:23',
			});

		const jumpLink = screen.getByLabelText('Jump to results');
		expect(jumpLink).toBeTruthy();
		expect(jumpLink.getAttribute('href')).toBe('#tool-result-generation-1:23');
		expect(document.querySelector('[data-chat-tool-result-placeholder]')).toBeNull();
	});

	it('reserves the result-link geometry before a Glob result arrives', () => {
		const { container } = render(ChatToolEventRenderer, {
			toolMessage: new GlobToolUseMessage('', 'tool-glob-2', '**/*.ts'),
			mode: 'input',
		});

		expect(screen.queryByLabelText('Jump to results')).toBeNull();
		expect(container.querySelector('[data-chat-tool-result-placeholder]')).toBeTruthy();
	});

		it('renders a Glob result as its own anchored row', () => {
		const toolResult = {
			content: { filenames: ['src/a.ts', 'src/b.ts'], numFiles: 2 },
		};
			const { container } = render(ChatToolEventRenderer, {
				toolMessage: new GlobToolUseMessage('', 'tool-glob-3', '**/*.ts'),
				toolResult,
				mode: 'result',
				resultAnchorId: 'tool-result-generation-1:25',
			});

			const anchor = container.querySelector('[id="tool-result-generation-1:25"]');
		expect(anchor).toBeTruthy();
	});

	it('renders result title derived from tool result data', () => {
		const toolResult = {
			content: { filenames: ['one.ts'], numFiles: 1 },
		};
			render(ChatToolEventRenderer, {
				toolMessage: new GlobToolUseMessage('', 'tool-glob-4', '*.ts'),
				toolResult,
				mode: 'result',
			autoExpandTools: true,
		});

		expect(screen.getByText('Found 1 file')).toBeTruthy();
	});

	it('renders plural file count in result title', () => {
		const toolResult = {
			content: { filenames: ['a.ts', 'b.ts', 'c.ts'], numFiles: 3 },
		};
			render(ChatToolEventRenderer, {
				toolMessage: new GlobToolUseMessage('', 'tool-glob-5', '*.ts'),
				toolResult,
				mode: 'result',
			autoExpandTools: true,
		});

		expect(screen.getByText('Found 3 files')).toBeTruthy();
	});

	it('renders grep result title from total match count', () => {
		const toolResult = {
			content: {
				filenames: ['src/a.ts', 'src/b.ts'],
				numFiles: 2,
				totalMatches: 5,
			},
		};
			render(ChatToolEventRenderer, {
				toolMessage: new GrepToolUseMessage('', 'tool-grep-1', 'needle', 'src'),
				toolResult,
				mode: 'result',
			autoExpandTools: true,
		});

		expect(screen.getByText('Found 5 matches')).toBeTruthy();
	});
});
