<script lang="ts">
	import { untrack } from 'svelte';
	import UserMessageNavigatorDialog from '../UserMessageNavigatorDialog.svelte';
	import type {
		UserMessageNavigatorDialogController,
		UserMessageNavigatorItem,
		UserMessageNavigatorLoadError,
		UserMessageNavigatorSelectionError,
	} from '$lib/chat/transcript/user-message-navigator-controller.svelte.js';

	interface NavigatorLoadUpdate {
		items?: readonly UserMessageNavigatorItem[];
		hasMore?: boolean;
		loadError?: UserMessageNavigatorLoadError | null;
	}

	interface Props {
		initialItems?: readonly UserMessageNavigatorItem[];
		initialHasMore?: boolean;
		initialLoading?: boolean;
		initialLoadError?: UserMessageNavigatorLoadError | null;
		initialSelectionError?: UserMessageNavigatorSelectionError | null;
		onLoadOlder?: (attempt: number) => Promise<NavigatorLoadUpdate | void>;
		onSelect?: (item: UserMessageNavigatorItem) => void;
		onClose?: () => void;
	}

	let {
		initialItems = [],
		initialHasMore = false,
		initialLoading = false,
		initialLoadError = null,
		initialSelectionError = null,
		onLoadOlder = async () => undefined,
		onSelect = () => {},
		onClose = () => {},
	}: Props = $props();

	let open = $state(true);
	let items = $state<readonly UserMessageNavigatorItem[]>(untrack(() => initialItems));
	let hasMore = $state(untrack(() => initialHasMore));
	let isInitialLoading = $state(untrack(() => initialLoading));
	let isLoadingOlder = $state(false);
	let loadError = $state<UserMessageNavigatorLoadError | null>(untrack(() => initialLoadError));
	let selectionError = $state<UserMessageNavigatorSelectionError | null>(
		untrack(() => initialSelectionError),
	);
	let loadAttempts = 0;

	async function loadOlder(): Promise<void> {
		if (!open || !hasMore || isLoadingOlder || loadError) return;
		isLoadingOlder = true;
		loadAttempts += 1;
		const update = await onLoadOlder(loadAttempts);
		if (update?.items) items = update.items;
		if (update?.hasMore !== undefined) hasMore = update.hasMore;
		if (update?.loadError !== undefined) loadError = update.loadError;
		isLoadingOlder = false;
	}

	const controller = {
		get open() {
			return open;
		},
		get items() {
			return items;
		},
		get hasMore() {
			return hasMore;
		},
		get isInitialLoading() {
			return isInitialLoading;
		},
		get isLoadingOlder() {
			return isLoadingOlder;
		},
		get loadError() {
			return loadError;
		},
		get selectionError() {
			return selectionError;
		},
		close() {
			open = false;
			onClose();
		},
		loadOlder,
		async retryLoadOlder() {
			loadError = null;
			await loadOlder();
		},
		async select(item: UserMessageNavigatorItem) {
			onSelect(item);
		},
	} satisfies UserMessageNavigatorDialogController;

	export function finishInitialLoading(): void {
		isInitialLoading = false;
	}
</script>

<UserMessageNavigatorDialog {controller} />
