<script lang="ts">
	import PullRequestDetailPanel from '../PullRequestDetailPanel.svelte';
	import { setPullRequests } from '$lib/context';
	import type { PullRequestDetail } from '$lib/api/pull-requests';

	interface PullRequestDetailPanelTestHostProps {
		detail: PullRequestDetail;
		onSendToChat: (message: string) => Promise<boolean>;
		onAfterSend: () => void;
	}

	let { detail, onSendToChat, onAfterSend }: PullRequestDetailPanelTestHostProps = $props();

	setPullRequests({
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
	} as never);
</script>

<PullRequestDetailPanel {onSendToChat} onClose={() => {}} {onAfterSend} />
