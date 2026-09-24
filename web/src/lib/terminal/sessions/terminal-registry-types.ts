import type {
	createTerminal,
	listTerminals,
	renameTerminal,
	terminateTerminal,
} from '$lib/api/terminals.js';
import type {
	TerminalRuntime,
	TerminalRuntimeOptions,
} from '$lib/terminal/runtime/terminal-runtime.svelte.js';
import type {
	TerminalTransportOptions,
	TerminalTransportStatus,
} from '$lib/ws/terminal-transport.svelte.js';
import type { PrimaryWsConnectionPort } from '$lib/ws/connection.svelte.js';
import type { TerminalMetadata, TerminalStreamClientMessage } from '$shared/terminal';
import type { ExecutionNodesStore } from '$lib/execution-nodes/execution-nodes-store.svelte.js';

export type TerminalSessionRuntime = Pick<
	TerminalRuntime,
	| 'write'
	| 'resendSize'
	| 'applyTheme'
	| 'dispose'
	| 'prepareRendererTransfer'
	| 'attach'
	| 'park'
	| 'scheduleFit'
	| 'focus'
	| 'pasteFromClipboard'
	| 'applyFontSize'
	| 'clipboardMessage'
	| 'sendToolbarKey'
> & {
	readonly inputControls: Pick<
		TerminalRuntime['inputControls'],
		'ctrlMode' | 'altMode' | 'toggleModifier'
	>;
};

export type TerminalAttachmentState =
	'connecting' | 'attached' | 'detached' | 'taken-over' | 'unavailable';

export interface TerminalClientSession {
	metadata: TerminalMetadata;
	attachmentState: TerminalAttachmentState;
	runtimeState: 'idle' | 'loading' | 'ready' | 'failed';
	runtimeError: string | null;
	runtimeErrorRequiresPageReload: boolean;
	lastReceivedSequence: number;
	replayTruncatedAt: number | null;
}

export interface TerminalNodeInventory {
	status: 'loading' | 'ready' | 'failed';
	runtimeId?: string;
	epoch?: string;
	error: string | null;
}

export interface TerminalRegistryDeps {
	nodes?: Pick<ExecutionNodesStore, 'nodes' | 'label' | 'onChanged'>;
	connection: PrimaryWsConnectionPort;
	getClientId(): string;
	now?: () => number;
	listTerminals?: typeof listTerminals;
	createTerminal?: typeof createTerminal;
	terminateTerminal?: typeof terminateTerminal;
	renameTerminal?: typeof renameTerminal;
	createTransport?: (options: TerminalTransportOptions) => TerminalTransportPort;
	createRuntime?: (
		options: TerminalRuntimeOptions,
	) => TerminalSessionRuntime | Promise<TerminalSessionRuntime>;
	loadRuntime?: () => Promise<TerminalRuntimeModule>;
	reloadApplication?: () => void;
	onSuccessfulList?(terminalIds: readonly string[], nodeId: string): void;
	onSessionTerminated?(terminalId: string): void;
}

export interface TerminalRuntimeModule {
	createTerminalRuntime(options: TerminalRuntimeOptions): Promise<TerminalSessionRuntime>;
}

export interface TerminalTransportPort {
	readonly status: TerminalTransportStatus;
	connect(): void;
	send(message: TerminalStreamClientMessage): boolean;
	suspend(): void;
	destroy(): void;
}
