import type { ChatMaxWidth } from '$lib/stores/local-settings.svelte';

export const CHAT_FEED_CONTENT_BASE_CLASS = 'flex w-full flex-col gap-2 px-[29px] sm:gap-3';

export const CHAT_MAX_WIDTH_FEED_VIEWPORT_CLASS: Record<ChatMaxWidth, string> = {
	none: 'lg:px-0',
	large: 'lg:px-6',
	medium: 'lg:px-6',
	small: 'lg:px-6',
};

export const CHAT_MAX_WIDTH_FEED_CONTENT_CLASS: Record<ChatMaxWidth, string> = {
	none: 'lg:px-8',
	large: 'lg:mx-auto lg:max-w-5xl lg:px-5',
	medium: 'lg:mx-auto lg:max-w-4xl lg:px-5',
	small: 'lg:mx-auto lg:max-w-3xl lg:px-5',
};

export const CHAT_MAX_WIDTH_COMPOSER_SHELL_CLASS: Record<ChatMaxWidth, string> = {
	none: 'lg:px-3',
	large: 'lg:px-6 lg:pb-4',
	medium: 'lg:px-6 lg:pb-4',
	small: 'lg:px-6 lg:pb-4',
};

export const CHAT_MAX_WIDTH_COMPOSER_FRAME_CLASS: Record<ChatMaxWidth, string> = {
	none: '',
	large: 'lg:mx-auto lg:max-w-5xl',
	medium: 'lg:mx-auto lg:max-w-4xl',
	small: 'lg:mx-auto lg:max-w-3xl',
};
