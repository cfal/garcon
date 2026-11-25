import {
	getChatSessions,
	getFileSessions,
	getModelCatalog,
	getTerminalRegistry,
	getWorkspaceCoordinator,
} from '$lib/context';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types.js';
import * as m from '$lib/paraglide/messages.js';

export function createWorkspaceSurfaceCatalog(
	requestProjectFolder: (chat: ChatSessionRecord) => void,
) {
	const sessions = getChatSessions();
	const modelCatalog = getModelCatalog();
	const workspace = getWorkspaceCoordinator();
	const terminals = getTerminalRegistry();
	const fileSessions = getFileSessions();

	const singletonLabels = $derived({
		git: m.workspace_surface_git(),
		'git-history': m.workspace_surface_git_history(),
		'git-compare': m.workspace_surface_git_compare(),
		'pull-requests': m.workspace_surface_pull_requests_short(),
		files: m.workspace_surface_files(),
		commit: m.workspace_surface_commit(),
		'chat-map': m.workspace_surface_chat_map(),
		'chat-canvas': m.workspace_surface_chat_canvas(),
		'chat-board': m.workspace_surface_chat_board(),
		tickets: m.tickets_title(),
		usage: m.workspace_surface_usage(),
	});

	function label(surfaceId: string): string {
		const surface = workspace.layout.snapshot.surfaces[surfaceId];
		if (!surface) return m.workspace_surface_view();
		if (surface.type === 'chat') {
			return surface.chatId
				? sessions.byId[surface.chatId]?.title || m.chat_window_untitled()
				: m.workspace_surface_chat();
		}
		if (surface.type === 'terminal') {
			const metadata = terminals.sessions[surface.terminalId]?.metadata;
			return metadata ? terminals.displayName(metadata) : m.workspace_surface_terminal();
		}
		if (surface.type === 'file') {
			const session = fileSessions.get(surface.fileSessionId);
			return session
				? `${session.fileName}${session.dirty ? ' *' : ''}`
				: m.workspace_surface_file();
		}
		if (surface.type === 'terminal-launcher') return m.workspace_surface_terminal();
		return singletonLabels[surface.kind];
	}

	const onChooseProjectFolder = $derived.by(() => {
		const chat = sessions.selectedChat;
		if (
			!chat ||
			!modelCatalog.forExecutor(chat.executorId).supportsUpdateProjectPath(chat.agentId)
		) {
			return undefined;
		}
		return () => requestProjectFolder(chat);
	});

	return {
		label,
		get onChooseProjectFolder() {
			return onChooseProjectFolder;
		},
	};
}
