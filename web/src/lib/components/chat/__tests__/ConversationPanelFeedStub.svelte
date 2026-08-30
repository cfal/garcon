<script lang="ts">
	import type { ConversationFeedPresentationPort } from '$lib/chat/transcript/conversation-feed-presentation-port.js';

	let {
		scrollContainer = $bindable<HTMLDivElement | null>(null),
		announcementsEnabled = false,
		reserveComposerTraySpace = false,
		onLoadEarlier,
		onLoadLater,
		onForkChat,
		onPresentationPortChange,
	}: {
		scrollContainer?: HTMLDivElement | null;
		announcementsEnabled?: boolean;
		reserveComposerTraySpace?: boolean;
		onLoadEarlier?: () => void;
		onLoadLater?: () => void;
		onForkChat?: (ordinal?: number) => void;
		onPresentationPortChange?: (port: ConversationFeedPresentationPort | null) => void;
	} = $props();

	const presentation: ConversationFeedPresentationPort = {
		captureRestoreTarget: () => ({ kind: 'end' }),
		closeTransients: () => {},
	};

	$effect(() => {
		onPresentationPortChange?.(presentation);
		return () => onPresentationPortChange?.(null);
	});
</script>

<div
	bind:this={scrollContainer}
	data-conversation-feed-stub
	data-announcements-enabled={announcementsEnabled}
	data-reserve-composer-tray-space={reserveComposerTraySpace}
>
	<button type="button" onclick={onLoadEarlier}>Load earlier</button>
	<button type="button" onclick={onLoadLater}>Load later</button>
	<button type="button" onclick={() => onForkChat?.(7)}>Fork</button>
</div>
