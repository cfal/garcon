import type { MarkdownLinkNavigateEvent } from '$lib/components/rich-text/Markdown.svelte';
import {
	resolveFileLinkTarget, resolveImageFileTarget, type ResolveMarkdownImageFile,
} from '$lib/chat/file-links/file-link-resolver.js';
import { resolveFileOpenTarget } from '$lib/chat/file-links/file-open-target.js';
import {
	resolveChatReferenceTarget, type ResolveChatReference,
} from '$lib/chat/transcript/chat-reference.js';
import { getAppShell, getChatSessions, getExecutors, getFileSessions, getNotifications, getWorkspaceCoordinator } from '$lib/context';
import * as m from '$lib/paraglide/messages.js';

interface ChatMarkdownNavigationOptions {
	readonly sourceChatId?: string;
	readonly executorId: string;
	readonly projectPath: string | null;
}

export function createChatMarkdownNavigation(options: ChatMarkdownNavigationOptions) {
	const sessions = getChatSessions();
	const fileSessions = getFileSessions();
	const executors = getExecutors();
	const appShell = getAppShell();
	const workspace = getWorkspaceCoordinator();
	const notifications = getNotifications();

	const resolveChatReference: ResolveChatReference = chatId =>
		resolveChatReferenceTarget(chatId, options.sourceChatId, sessions.byId[chatId]);

	const resolveImageFile: ResolveMarkdownImageFile = href => {
		const { executorId, projectPath } = options;
		const fileRootPath = executors.get(executorId)?.projectBasePath;
		if (!executors.filesAvailable(executorId) || !fileRootPath || !projectPath) return null;
		return resolveImageFileTarget(href, {
			executorId,
			executorContextKey: executors.pathContextKey(executorId),
			fileRootPath,
			sourceDirectoryPath: projectPath,
		});
	};

	function handleLinkNavigate(link: MarkdownLinkNavigateEvent): boolean | void {
		if (link.kind !== 'file') return;
		const { executorId, projectPath } = options;
		if (!executors.filesAvailable(executorId)) {
			notifications.error(m.file_command_executor_unavailable(), { key: 'file-executor-unavailable' });
			return true;
		}
		const fileRootPath = executors.get(executorId)?.projectBasePath;
		if (!fileRootPath) {
			notifications.error(m.markdown_file_link_root_unavailable({ path: link.rawHref }), {
				key: 'file-root-unavailable',
			});
			return true;
		}
		if (!projectPath) return true;
		const resolved = resolveFileLinkTarget(link.rawHref, {
			fileRootPath,
			sourceDirectoryPath: projectPath,
		});
		if (!resolved) return;
		openFile(executorId, resolved);
		return true;
	}

	function handleToolFileOpen(filePath: string): void {
		const { executorId, projectPath } = options;
		if (!projectPath || !executors.filesAvailable(executorId)) return;
		const resolved = resolveFileOpenTarget(filePath, {
			fileRootPath: executors.get(executorId)?.projectBasePath ?? '',
			sourceDirectoryPath: projectPath,
		});
		if (resolved) openFile(executorId, resolved);
	}

	function openFile(executorId: string, resolved: NonNullable<ReturnType<typeof resolveFileLinkTarget>>): void {
		void fileSessions.open({
			executorId,
			fileRootPath: resolved.fileRootPath,
			relativePath: resolved.relativePath,
			mode: 'auto',
			origin: appShell.isMobile ? 'mobile' : workspace.currentWindowId,
			reason: 'user-open',
			line: resolved.line,
			col: resolved.col,
		});
	}

	return { handleLinkNavigate, handleToolFileOpen, resolveImageFile, resolveChatReference };
}
