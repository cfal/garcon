<!-- Renders one real sidebar chat row per layout option so the wizard previews
     the actual SidebarChatSummary output instead of abstract placeholder bars.
     The sample session is deterministic; the container mirrors the sidebar row
     background and selection styling. -->
<script lang="ts">
	import SidebarChatSummary from '../sidebar/SidebarChatSummary.svelte';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { SidebarChatItemLayout } from '$lib/stores/local-settings.svelte.js';
	import { cn } from '$lib/utils/cn.js';

	interface OnboardingChatLayoutPreviewProps {
		layout: SidebarChatItemLayout;
		isSelected: boolean;
	}

	let { layout, isSelected }: OnboardingChatLayoutPreviewProps = $props();

	const PREVIEW_NOW = new Date('2026-09-04T12:00:00.000Z');
	const previewSession: ChatSessionRecord = {
		id: 'onboarding-layout-preview',
		parentChat: null,
		projectPath: '/workspace/aurora',
		effectiveProjectKey: '/workspace/aurora',
		projectIdentityState: 'available',
		orderGroup: 'normal',
		title: 'Release checklist review',
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		createdAt: '2026-09-04T09:00:00.000Z',
		lastActivityAt: '2026-09-04T11:30:00.000Z',
		lastReadAt: null,
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		processingPhase: null,
		canReloadFromNativeHistory: false,
		isUnread: false,
		status: 'running',
		agentOwnershipEpoch: null,
		lastMessage: 'Draft the release notes and verify the upgrade path.',
		tags: ['release'],
	};
</script>

<div
	data-onboarding-layout-preview={layout}
	data-selected={isSelected}
	class={cn(
		'w-full min-w-0 overflow-hidden rounded-md border border-border pl-[9px] pr-2 text-left select-none',
		layout === 'single-line' ? 'py-[2px]' : 'py-[5px]',
		isSelected ? 'bg-sidebar-chat-item-selected-bg' : 'bg-sidebar-chat-item-bg',
	)}
	aria-hidden="true"
>
	<SidebarChatSummary
		session={previewSession}
		{isSelected}
		currentTime={PREVIEW_NOW}
		showTimestamp={true}
		showProjectPath={false}
		chatItemLayout={layout}
	/>
</div>
