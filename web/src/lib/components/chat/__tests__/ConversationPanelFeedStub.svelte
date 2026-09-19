<script lang="ts">
	import type { ConversationFeedPresentationPort } from '$lib/chat/transcript/conversation-feed-presentation-port.js';
	import type { ConversationViewportPort } from '$lib/chat/transcript/conversation-viewport-port.js';
	import type { ConversationMessageChatContext } from '$lib/chat/transcript/conversation-message-context.js';

	let {
		chatContext,
		scrollContainer = $bindable<HTMLDivElement | null>(null),
		announcementsEnabled = false,
		reserveComposerTraySpace = false,
		onLoadEarlier,
		onLoadLater,
		onForkChat,
		onViewportPortChange,
		onPresentationPortChange,
	}: {
		chatContext: ConversationMessageChatContext;
		scrollContainer?: HTMLDivElement | null;
		announcementsEnabled?: boolean;
		reserveComposerTraySpace?: boolean;
		onLoadEarlier?: () => void;
		onLoadLater?: () => void;
		onForkChat?: (ordinal?: number) => void;
		onViewportPortChange?: (port: ConversationViewportPort | null) => void;
		onPresentationPortChange?: (port: ConversationFeedPresentationPort | null) => void;
	} = $props();

	const presentation: ConversationFeedPresentationPort = {
		captureRestoreTarget: () => ({
			kind: 'row',
			transcriptViewId: 'view-1',
			ordinal: 1,
			viewportOffset: 12,
		}),
		closeTransients: () => {},
	};
	const viewport: ConversationViewportPort = {
		isReady: () => true,
		hasCollapsedToolGroups: () => false,
		isAtEnd: () => false,
		ownsScrollPosition: () => false,
		viewportPosition: () => null,
		scrollToStart: () => {},
		scrollToEnd: () => {},
		restoreInitialEnd: () => {},
		scrollBy: () => {},
		waitForLayout: async () => 'settled',
		measureViewportFill: async () => 'overflow',
		restoreHiddenReadingPosition: async () => 'restored',
		cancelPendingLayoutMutation: () => {},
		cancelForUserIntent: () => 'cancelled',
		setNativeScrollActivity: () => {},
		scrollToTarget: async () => 'completed',
	};

	$effect(() => {
		onViewportPortChange?.(viewport);
		return () => onViewportPortChange?.(null);
	});

	$effect(() => {
		onPresentationPortChange?.(presentation);
		return () => onPresentationPortChange?.(null);
	});
</script>

<div
	bind:this={scrollContainer}
	data-conversation-feed-stub
	data-chat-context={JSON.stringify(chatContext)}
	data-announcements-enabled={announcementsEnabled}
	data-reserve-composer-tray-space={reserveComposerTraySpace}
>
	<button type="button" onclick={onLoadEarlier}>Load earlier</button>
	<button type="button" onclick={onLoadLater}>Load later</button>
	<button type="button" onclick={() => onForkChat?.(7)}>Fork</button>
	<button type="button" data-detach-feed onclick={() => onPresentationPortChange?.(null)}>
		Detach feed
	</button>
	<button
		type="button"
		data-replace-viewport
		onclick={() => onViewportPortChange?.({ ...viewport })}
	>
		Replace viewport
	</button>
</div>
