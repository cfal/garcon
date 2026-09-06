import type { AgentSettingDescriptor } from '$shared/agent-integration';
import type { ResendCandidate } from '$shared/chat-view';
import type { JsonValue } from '$shared/json';
import type { PermissionMode, ThinkingMode } from '$lib/types/chat';
import type { ModelSelectorChange } from '$lib/components/model-selector/model-selector-types';

export interface PromptComposerProps {
	onsubmit: () => void;
	onSteerPreferredSubmit: () => void;
	onModelChange?: (selection: ModelSelectorChange) => void;
	onPermissionModeChange?: (mode: PermissionMode) => void;
	onThinkingModeChange?: (mode: ThinkingMode) => void;
	onAgentSettingChange?: (descriptor: AgentSettingDescriptor, value: JsonValue) => void;
	resendCandidates?: readonly ResendCandidate[];
	onExcludeResendCandidate?: (ordinal: number) => void;
	directAdmissionPending?: boolean;
	requiresQueuedSubmission?: boolean;
	isVisible?: boolean;
	isPresented?: boolean;
	composerEditorOpenRequestId?: number;
	onChooseProjectFolder?: (chatId: string) => void;
}
