import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	AssistantMessage,
	TranscriptNoticeMessage,
	UserMessage,
	ThinkingMessage,
	CliRowMessage,
	CompactionMessage,
	ExitPlanModeToolUseMessage,
	CursorCreatePlanToolUseMessage,
	AmpOracleToolUseMessage,
	PermissionRequestMessage,
} from '$shared/chat-types';
import type { ConversationDisclosureStatePort } from '../ConversationFeedItemState.svelte.js';
import * as filesApi from '$lib/api/files.js';
import ConversationMessageHost from './ConversationMessageHost.svelte';
import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';

const TS = '2026-05-14T00:00:00.000Z';

describe('ConversationMessage file links', () => {
	it('opens a remote panel link on its owning executor while Local is selected', async () => {
		const openAuto = vi.fn();
		render(ConversationMessageHost, {
			message: new AssistantMessage(TS, 'Open [remote file](file.txt)'),
			openAuto,
			chatContext: {
				chatId: 'remote-chat',
				executorId: remoteExecutor.id,
				projectPath: '/worker/project',
			},
			executors: [
				localExecutor,
				{
					...remoteExecutor,
					machineServices: { files: true, git: false, gh: false, terminals: false },
				},
			],
		});
		await fireEvent.click(screen.getByRole('link', { name: 'remote file' }));
		expect(openAuto).toHaveBeenCalledWith(
			expect.objectContaining({
				executorId: remoteExecutor.id,
				fileRootPath: '/worker',
				relativePath: 'project/file.txt',
			}),
		);
	});

	it('does not redirect an unavailable remote panel link to Local', async () => {
		const openAuto = vi.fn();
		render(ConversationMessageHost, {
			message: new AssistantMessage(TS, 'Open [remote file](file.txt)'),
			openAuto,
			chatContext: {
				chatId: 'remote-chat',
				executorId: remoteExecutor.id,
				projectPath: '/workspace/project',
			},
			executors: [
				localExecutor,
				{
					...remoteExecutor,
					availability: 'offline',
					machineServices: { files: true, git: false, gh: false, terminals: false },
				},
			],
		});
		await fireEvent.click(screen.getByRole('link', { name: 'remote file' }));
		expect(openAuto).not.toHaveBeenCalled();
		expect(screen.getByText('Files are unavailable on this executor.')).toBeTruthy();
	});
	it('opens absolute markdown links under base but outside the chat project', async () => {
		const openAuto = vi.fn();
		render(ConversationMessageHost, {
			message: new AssistantMessage(TS, 'Open [readme](/workspace/other/README.md)'),
			openAuto,
			projectBasePath: '/workspace',
			chatProjectPath: '/workspace/current',
		});

		await fireEvent.click(screen.getByRole('link', { name: 'readme' }));

		expect(openAuto).toHaveBeenCalledWith(
			expect.objectContaining({
				fileRootPath: '/workspace',
				relativePath: 'other/README.md',
				origin: 'window-main',
				reason: 'user-open',
			}),
		);
		expect(openAuto.mock.calls[0]?.[0]).not.toHaveProperty('chatId');
	});

	it('carries the mobile presentation origin', async () => {
		const openAuto = vi.fn();
		render(ConversationMessageHost, {
			message: new AssistantMessage(TS, 'Open [readme](README.md)'),
			openAuto,
			isMobile: true,
		});

		await fireEvent.click(screen.getByRole('link', { name: 'readme' }));

		expect(openAuto).toHaveBeenCalledWith(
			expect.objectContaining({
				relativePath: 'project/README.md',
				origin: 'mobile',
			}),
		);
	});

	it('resolves sibling relative links from the chat project under the base root', async () => {
		const openAuto = vi.fn();
		render(ConversationMessageHost, {
			message: new AssistantMessage(TS, 'Open [shared](../shared/README.md:12)'),
			openAuto,
			projectBasePath: '/workspace',
			chatProjectPath: '/workspace/current',
		});

		await fireEvent.click(screen.getByRole('link', { name: 'shared' }));

		expect(openAuto).toHaveBeenCalledWith(
			expect.objectContaining({
				fileRootPath: '/workspace',
				relativePath: 'shared/README.md',
				line: 12,
			}),
		);
	});

	it('does not open absolute markdown links outside the base path', async () => {
		const openAuto = vi.fn();
		render(ConversationMessageHost, {
			message: new AssistantMessage(TS, 'Open [secret](/tmp/secret.md)'),
			openAuto,
			projectBasePath: '/workspace',
			chatProjectPath: '/workspace/current',
		});

		await fireEvent.click(screen.getByRole('link', { name: 'secret' }));

		expect(openAuto).not.toHaveBeenCalled();
	});

	it('does not resolve received inter-agent file links against the receiving chat project', async () => {
		const openAuto = vi.fn();
		render(ConversationMessageHost, {
			message: new TranscriptNoticeMessage(TS, 'Open [config](src/config.ts)', {
				type: 'inter-agent-message-received',
				fromChatId: '1788090107980900',
			}),
			openAuto,
			projectBasePath: '/workspace',
			chatProjectPath: '/workspace/receiver',
		});

		await fireEvent.click(screen.getByRole('link', { name: 'config' }));

		expect(openAuto).not.toHaveBeenCalled();
	});
});

describe('ConversationMessage local images', () => {
	const content = '![Capture](capture.png)';
	const disclosureState = {
		open: () => true,
		setOpen: () => {},
	} satisfies ConversationDisclosureStatePort;
	beforeEach(() => {
		vi.stubGlobal('IntersectionObserver', undefined);
		vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
		vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
		vi.spyOn(filesApi, 'readContent').mockResolvedValue({
			blob: new Blob(['synthetic image'], { type: 'image/png' }),
			revision: 'v1:synthetic',
		});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it.each([
		['user', new UserMessage(TS, content)],
		['thinking', new ThinkingMessage(TS, content)],
		['CLI', new CliRowMessage(TS, content, { style: 'info' }, 'markdown')],
		['compaction', new CompactionMessage(TS, 'auto', content)],
		['handoff', new TranscriptNoticeMessage(TS, content, { type: 'handoff-summary' })],
		[
			'outbound message',
			new TranscriptNoticeMessage(TS, content, {
				type: 'inter-agent-message-outcome',
				results: [{ chatId: '1700000000000001', status: 'delivered' }],
			}),
		],
		['plan', new ExitPlanModeToolUseMessage(TS, 'tool-plan', content)],
		['generic tool', new AmpOracleToolUseMessage(TS, 'tool-oracle', content)],
		[
			'plan permission',
			new PermissionRequestMessage(
				TS,
				'permission-plan',
				new ExitPlanModeToolUseMessage(TS, 'tool-plan', content),
			),
		],
		[
			'cursor plan permission',
			new PermissionRequestMessage(
				TS,
				'permission-cursor-plan',
				new CursorCreatePlanToolUseMessage(TS, 'tool-cursor-plan', content),
			),
		],
	] as const)('passes file context through %s Markdown', async (_label, message) => {
		render(ConversationMessageHost, { message, disclosureState });
		await waitFor(() =>
			expect(screen.getByRole('img', { name: 'Capture' }).getAttribute('src')).toBe('blob:preview'),
		);
		expect(filesApi.readContent).toHaveBeenCalledWith(
			{
				executorId: 'local',
				projectPath: '/workspace',
				filePath: 'project/capture.png',
			},
			{ signal: expect.any(AbortSignal), cache: 'no-store' },
		);
	});

	it.each([
		['assistant', new AssistantMessage(TS, content)],
		[
			'plan',
			new PermissionRequestMessage(
				TS,
				'permission-plan',
				new ExitPlanModeToolUseMessage(TS, 'tool-plan', content),
			),
		],
		[
			'cursor plan',
			new PermissionRequestMessage(
				TS,
				'permission-cursor',
				new CursorCreatePlanToolUseMessage(TS, 'tool-cursor', content),
			),
		],
	] as const)(
		'waits for the authoritative executor root in %s Markdown',
		async (_label, message) => {
			render(ConversationMessageHost, {
				message,
				disclosureState,
				projectBasePath: '/',
				executors: [{ ...localExecutor, projectBasePath: null }],
				executorUpdate: [localExecutor],
			});
			await waitFor(() => expect(screen.getByText('Unable to load image')).toBeTruthy());
			expect(filesApi.readContent).not.toHaveBeenCalled();
			await fireEvent.click(screen.getByRole('button', { name: 'Update executors' }));
			await waitFor(() =>
				expect(screen.getByRole('img', { name: 'Capture' }).getAttribute('src')).toBe(
					'blob:preview',
				),
			);
			expect(filesApi.readContent).toHaveBeenCalledExactlyOnceWith(
				{ executorId: 'local', projectPath: '/workspace', filePath: 'project/capture.png' },
				{ signal: expect.any(AbortSignal), cache: 'no-store' },
			);
		},
	);

	it('does not read received inter-agent images from the receiving executor', async () => {
		render(ConversationMessageHost, {
			message: new TranscriptNoticeMessage(TS, content, {
				type: 'inter-agent-message-received',
				fromChatId: '1700000000000001',
			}),
			disclosureState,
		});
		await waitFor(() => expect(screen.getByText('Unable to load image')).toBeTruthy());
		expect(filesApi.readContent).not.toHaveBeenCalled();
	});

	it.each([
		['assistant', new AssistantMessage(TS, content)],
		[
			'plan',
			new PermissionRequestMessage(
				TS,
				'permission-plan',
				new ExitPlanModeToolUseMessage(TS, 'tool-plan', content),
			),
		],
		[
			'cursor plan',
			new PermissionRequestMessage(
				TS,
				'permission-cursor',
				new CursorCreatePlanToolUseMessage(TS, 'tool-cursor', content),
			),
		],
	] as const)('invalidates an old executor instance in %s Markdown', async (_label, message) => {
		let finish!: (result: Awaited<ReturnType<typeof filesApi.readContent>>) => void;
		vi.mocked(filesApi.readContent).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		render(ConversationMessageHost, {
			message,
			disclosureState,
			executorUpdate: [{ ...localExecutor, instanceId: 'replacement-instance' }],
		});
		await waitFor(() => expect(filesApi.readContent).toHaveBeenCalledOnce());
		const oldSignal = vi.mocked(filesApi.readContent).mock.calls[0][1]?.signal;
		await fireEvent.click(screen.getByRole('button', { name: 'Update executors' }));
		await waitFor(() => expect(filesApi.readContent).toHaveBeenCalledTimes(2));
		expect(oldSignal?.aborted).toBe(true);
		expect(filesApi.readContent).toHaveBeenLastCalledWith(
			{ executorId: 'local', projectPath: '/workspace', filePath: 'project/capture.png' },
			{ signal: expect.any(AbortSignal), cache: 'no-store' },
		);
		finish({ blob: new Blob(['retired image'], { type: 'image/png' }), revision: 'v1:retired' });
		await waitFor(() =>
			expect(screen.getByRole('img', { name: 'Capture' }).getAttribute('src')).toBe('blob:preview'),
		);
		expect(URL.createObjectURL).toHaveBeenCalledOnce();
	});

	it.each([
		['capture.png', 'project/capture.png'],
		['/worker/shared/capture.png', 'shared/capture.png'],
	])(
		'loads %s from the owning executor, not the selected Local executor',
		async (href, filePath) => {
			render(ConversationMessageHost, {
				message: new AssistantMessage(TS, `![Capture](${href})`),
				chatContext: {
					chatId: 'remote-chat',
					executorId: remoteExecutor.id,
					projectPath: '/worker/project',
				},
				executors: [
					localExecutor,
					{
						...remoteExecutor,
						machineServices: { files: true, git: false, gh: false, terminals: false },
					},
				],
			});
			await waitFor(() =>
				expect(filesApi.readContent).toHaveBeenCalledWith(
					{
						executorId: remoteExecutor.id,
						projectPath: '/worker',
						filePath,
					},
					{ signal: expect.any(AbortSignal), cache: 'no-store' },
				),
			);
			expect(screen.getByRole('img', { name: 'Capture' }).getAttribute('src')).toBe('blob:preview');
		},
	);

	it.each(['/outside/capture.png', '../../capture.png'])(
		'does not request an image outside the configured root: %s',
		async (href) => {
			render(ConversationMessageHost, {
				message: new AssistantMessage(TS, `![Capture](${href})`),
			});
			await waitFor(() => expect(screen.getByText('Unable to load image')).toBeTruthy());
			expect(filesApi.readContent).not.toHaveBeenCalled();
		},
	);

	it('never falls back to Local for an unavailable remote executor', async () => {
		render(ConversationMessageHost, {
			message: new AssistantMessage(TS, '![Capture](capture.png)'),
			chatContext: {
				chatId: 'remote-chat',
				executorId: remoteExecutor.id,
				projectPath: '/worker/project',
			},
			executors: [localExecutor, { ...remoteExecutor, availability: 'offline' }],
		});
		await waitFor(() => expect(screen.getByText('Unable to load image')).toBeTruthy());
		expect(filesApi.readContent).not.toHaveBeenCalled();
	});
});
