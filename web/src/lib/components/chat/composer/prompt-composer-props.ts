import type { AgentSettingDescriptor } from '$shared/agent-integration';
import type { UserRowSummary } from '$shared/transcript-display-auxiliary';
import type { ComposerAvailabilityNoticePresentation } from '$lib/chat/composer/composer-availability.js';
import type { JsonValue } from '$shared/json';
import type { PermissionMode, ThinkingMode } from '$lib/types/chat';
import type { ModelSelectorChange } from '$lib/components/model-selector/model-selector-types';
import type { PromptRecallSource } from '$lib/chat/composer/prompt-recall';
import type { DisplaySummaryPaging } from '$lib/chat/transcript/display-summary-controller.svelte.js';

export interface PromptComposerProps {
	onsubmit: () => void;
	onSteerPreferredSubmit: () => void;
	onModelChange?: (selection: ModelSelectorChange) => void;
	onExecutorChange?: (executorId: string) => void;
	onPermissionModeChange?: (mode: PermissionMode) => void;
	onThinkingModeChange?: (mode: ThinkingMode) => void;
	onAgentSettingChange?: (descriptor: AgentSettingDescriptor, value: JsonValue) => void;
	resendCandidates?: readonly UserRowSummary[];
	resendPaging?: DisplaySummaryPaging;
	recallSource?: PromptRecallSource | null;
	onRecallError?: (message: string) => void;
	recallIdentity?: string | null;
	onExcludeResendCandidate?: (ordinal: number) => void;
	directAdmissionPending?: boolean;
	requiresQueuedSubmission?: boolean;
	isVisible?: boolean;
	isPresented?: boolean;
	composerEditorOpenRequestId?: number;
	onChooseProjectFolder?: (chatId: string) => void;
	onAvailabilityNoticeChange?: (notice: ComposerAvailabilityNoticePresentation | null) => void;
}
