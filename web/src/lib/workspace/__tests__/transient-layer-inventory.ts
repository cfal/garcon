export const TRANSIENT_PRIMITIVE_CONTENT = [
	'components/ui/context-menu/context-menu-content.svelte',
	'components/ui/dialog/dialog-content.svelte',
	'components/ui/dropdown-menu/dropdown-menu-content.svelte',
	'components/ui/popover/popover-content.svelte',
	'components/ui/select/select-content.svelte',
] as const;

export const CUSTOM_TRANSIENT_SOURCES = [
	'components/chat/DirectoryBrowser.svelte',
	'components/chat/FileMentionMenu.svelte',
	'components/chat/NewChatForm.svelte',
	'components/chat/PromptComposer.svelte',
	'components/chat/SlashCommandMenu.svelte',
	'components/git/GitCommentPopover.svelte',
	'components/git/GitDiffLineContextMenu.svelte',
	'components/shared/CommandMenu.svelte',
] as const;

export const TRANSIENT_BACKDROP_SOURCES = [
	'components/ui/dialog/dialog-overlay.svelte',
	'components/shared/CommandMenu.svelte',
	'components/sidebar/SidebarSearchDialog.svelte',
	'components/git/GitPushModal.svelte',
	'components/git/GitReviewChangesModal.svelte',
	'components/workspace/RightSidebarHost.svelte',
	'components/layout/AppShell.svelte',
] as const;

export const GLOBAL_KEYBOARD_OWNER = 'components/shared/KeyboardShortcuts.svelte';
