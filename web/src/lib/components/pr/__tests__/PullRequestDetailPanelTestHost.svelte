<script lang="ts">
	import PullRequestDetailPanel from '../PullRequestDetailPanel.svelte';
	import type { PullRequestDetail } from '$lib/api/pull-requests';

	interface PullRequestDetailPanelTestHostProps {
		detail: PullRequestDetail;
		onSendToChat: (message: string) => Promise<boolean>;
		onAfterSend: () => void;
	}

	let { detail, onSendToChat, onAfterSend }: PullRequestDetailPanelTestHostProps = $props();

	const controller = {
		get detail() {
			return detail;
		},
		get isDetailLoading() {
			return false;
		},
		get detailError() {
			return null;
		},
		get selectedNumber() {
			return detail.number;
		},
		loadDetail() {},
	} as never;
</script>

<PullRequestDetailPanel {controller} {onSendToChat} onClose={() => {}} {onAfterSend} />
