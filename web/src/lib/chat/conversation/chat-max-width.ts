import type { ChatMaxWidth } from '$lib/stores/local-settings.svelte';

// Layout-only shell shared by every width option. Horizontal insets are owned
// per-option so the "None" mode can reduce its inset independently.
export const CHAT_FEED_CONTENT_BASE_CLASS = 'flex w-full flex-col gap-2 sm:gap-3';

export const CHAT_DOCK_SHELL_BASE_CLASS = 'flex-shrink-0 bg-background px-2';

export const CHAT_DOCK_SURFACE_CLASS =
	'overflow-hidden rounded-2xl border border-border bg-card shadow-sm';

export const CHAT_MAX_WIDTH_FEED_VIEWPORT_CLASS: Record<ChatMaxWidth, string> = {
	none: 'lg:px-0',
	large: 'lg:px-6',
	medium: 'lg:px-6',
	small: 'lg:px-6',
};

export const CHAT_MAX_WIDTH_FEED_CONTENT_CLASS: Record<ChatMaxWidth, string> = {
	none: 'px-4 lg:px-5',
	large: 'px-[29px] lg:mx-auto lg:max-w-5xl lg:px-5',
	medium: 'px-[29px] lg:mx-auto lg:max-w-4xl lg:px-5',
	small: 'px-[29px] lg:mx-auto lg:max-w-3xl lg:px-5',
};

export const CHAT_MAX_WIDTH_DOCK_SHELL_CLASS: Record<ChatMaxWidth, string> = {
	none: 'lg:px-3',
	large: 'lg:px-6',
	medium: 'lg:px-6',
	small: 'lg:px-6',
};

export const CHAT_MAX_WIDTH_COMPOSER_SPACING_CLASS: Record<ChatMaxWidth, string> = {
	none: 'pb-2',
	large: 'pb-2 lg:pb-4',
	medium: 'pb-2 lg:pb-4',
	small: 'pb-2 lg:pb-4',
};

export const CHAT_MAX_WIDTH_DOCK_FRAME_CLASS: Record<ChatMaxWidth, string> = {
	none: '',
	large: 'lg:mx-auto lg:max-w-5xl',
	medium: 'lg:mx-auto lg:max-w-4xl',
	small: 'lg:mx-auto lg:max-w-3xl',
};
