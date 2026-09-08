import type { ChatMaxWidth } from '$lib/stores/local-settings.svelte';
import { cn } from '$lib/utils/cn';

// Layout-only shell shared by every width option. Horizontal insets are owned
// per-option so the "None" mode can reduce its inset independently.
export const CHAT_FEED_CONTENT_BASE_CLASS = 'flex w-full flex-col gap-2 sm:gap-3';

// The elevated composer uses this shared layout shell without repainting panel-owned status caps.
export const CHAT_DOCK_SHELL_BASE_CLASS = 'flex-shrink-0';

export const CHAT_DOCK_SURFACE_CLASS =
	'overflow-hidden rounded-2xl border border-border bg-card shadow-sm';

// Shrinks constrained gutters against each allocated chat pane while retaining their wide cap.
const CHAT_CONSTRAINED_OUTER_GUTTER_CLASS =
	'px-2 lg:px-[clamp(0.5rem,3%,1.5rem)]';
const CHAT_CONSTRAINED_FEED_INSET_CLASS =
	'px-[clamp(0.5rem,3%,1.3125rem)] lg:px-[clamp(0.5rem,3%,1.25rem)]';

export const CHAT_MAX_WIDTH_FEED_VIEWPORT_CLASS: Record<ChatMaxWidth, string> = {
	none: 'lg:px-0',
	large: CHAT_CONSTRAINED_OUTER_GUTTER_CLASS,
	medium: CHAT_CONSTRAINED_OUTER_GUTTER_CLASS,
	small: CHAT_CONSTRAINED_OUTER_GUTTER_CLASS,
};

export const CHAT_MAX_WIDTH_FEED_CONTENT_CLASS: Record<ChatMaxWidth, string> = {
	none: 'px-4 lg:px-5',
	large: cn(CHAT_CONSTRAINED_FEED_INSET_CLASS, 'lg:mx-auto lg:max-w-5xl'),
	medium: cn(CHAT_CONSTRAINED_FEED_INSET_CLASS, 'lg:mx-auto lg:max-w-4xl'),
	small: cn(CHAT_CONSTRAINED_FEED_INSET_CLASS, 'lg:mx-auto lg:max-w-3xl'),
};

export const CHAT_MAX_WIDTH_DOCK_SHELL_CLASS: Record<ChatMaxWidth, string> = {
	none: 'px-2 lg:px-3',
	large: CHAT_CONSTRAINED_OUTER_GUTTER_CLASS,
	medium: CHAT_CONSTRAINED_OUTER_GUTTER_CLASS,
	small: CHAT_CONSTRAINED_OUTER_GUTTER_CLASS,
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

export function chatDockFrameClass(chatMaxWidth: ChatMaxWidth): string {
	return cn('w-full', CHAT_MAX_WIDTH_DOCK_FRAME_CLASS[chatMaxWidth]);
}
