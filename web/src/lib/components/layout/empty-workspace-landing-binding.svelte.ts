import { untrack } from 'svelte';
import type { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte.js';
import type { AppShellStore } from '$lib/stores/app-shell.svelte.js';
import type { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte.js';
import {
	EmptyWorkspaceLandingController,
	type EmptyWorkspaceLandingSnapshot,
} from './empty-workspace-landing-controller.js';

interface EmptyWorkspaceLandingBindingOptions {
	readonly sessions: Pick<ChatSessionsStore, 'chatListStatus' | 'chatListError' | 'orderedChats'>;
	readonly shell: Pick<AppShellStore,
		'newChatDialogOpen' | 'showSettings' | 'showOnboardingWizard' | 'showPreambles' |
		'showSnippets' | 'showScheduledPrompts' | 'chatPreambleSelectionTarget'>;
	readonly transientLayers: Pick<TransientLayerRegistry, 'makesMainInert'>;
	openNewChat(): void;
	getNavigation(): Pick<EmptyWorkspaceLandingSnapshot, 'isBareRoute' | 'hasNavigationTarget'>;
}

/** Observes workspace changes while keeping dialog publication outside dependency tracking. */
export function bindEmptyWorkspaceLanding(options: EmptyWorkspaceLandingBindingOptions): void {
	const controller = new EmptyWorkspaceLandingController(() => options.openNewChat());
	$effect(() => {
		const { sessions, shell } = options;
		const snapshot: EmptyWorkspaceLandingSnapshot = {
			chatListStatus: sessions.chatListStatus,
			chatListError: sessions.chatListError,
			chatCount: sessions.orderedChats.length,
			...options.getNavigation(),
			newChatDialogOpen: shell.newChatDialogOpen,
			anotherDialogOpen: Boolean(options.transientLayers.makesMainInert || shell.showSettings || shell.showOnboardingWizard ||
				shell.showPreambles || shell.showSnippets || shell.showScheduledPrompts ||
				shell.chatPreambleSelectionTarget),
		};
		untrack(() => controller.observe(snapshot));
	});
}
