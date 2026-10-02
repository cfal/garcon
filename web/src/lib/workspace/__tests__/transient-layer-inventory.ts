export const TRANSIENT_PRIMITIVE_CONTENT = [
	'components/ui/context-menu/context-menu-content.svelte',
	'components/ui/dialog/dialog-content.svelte',
	'components/ui/dropdown-menu/dropdown-menu-content.svelte',
	'components/ui/popover/popover-content.svelte',
	'components/ui/select/select-content.svelte',
] as const;

export const CUSTOM_TRANSIENT_SOURCES = [
	'components/project-paths/DirectoryBrowser.svelte',
	'components/chat/composer/FileMentionMenu.svelte',
	'components/chat/new-chat/NewChatForm.svelte',
	'components/chat/composer/PromptComposer.svelte',
	'components/chat/composer/SlashCommandMenu.svelte',
	'components/layout/AppShell.svelte',
	'components/shared/CommandMenu.svelte',
] as const;

export const TRANSIENT_BACKDROP_SOURCES = [
	'components/ui/dialog/dialog-overlay.svelte',
	'components/shared/CommandMenu.svelte',
	'components/git/GitPushModal.svelte',
	'components/layout/AppShell.svelte',
] as const;

export const GLOBAL_KEYBOARD_OWNER = 'components/shared/KeyboardShortcuts.svelte';
