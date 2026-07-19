import {
	createQueuedInput,
	forkRunChat,
	runChat,
	sendActiveInput,
	startChat,
	type StartChatParams,
} from '$lib/api/chats.js';
import type {
	ActiveInputCommandRequest,
	ActiveInputCommandResponse,
	AgentRunCommandRequest,
	CommandAcceptedResponse,
	ForkRunCommandRequest,
	ForkRunCommandResponse,
	QueueEntryCommandResponse,
	QueueEntryCreateCommandRequest,
	StartChatCommandResponse,
} from '$shared/chat-command-contracts';
import { createClientCommandId } from './client-command-id.js';
import { submitIdempotentCommand } from './idempotent-command.js';

export interface PreparedAcceptedInput<T> {
	clientRequestId: string;
	clientMessageId?: string;
	submit(): Promise<T>;
}

export interface AcceptedInputTransport {
	start(request: StartChatParams): Promise<StartChatCommandResponse>;
	run(request: AgentRunCommandRequest): Promise<CommandAcceptedResponse>;
	fork(request: ForkRunCommandRequest): Promise<ForkRunCommandResponse>;
	enqueue(request: QueueEntryCreateCommandRequest): Promise<QueueEntryCommandResponse>;
	active(request: ActiveInputCommandRequest): Promise<ActiveInputCommandResponse>;
}

const defaultTransport: AcceptedInputTransport = {
	start: startChat,
	run: runChat,
	fork: forkRunChat,
	enqueue: createQueuedInput,
	active: sendActiveInput,
};

export class AcceptedInputSubmissionService {
	constructor(
		private readonly transport: AcceptedInputTransport = defaultTransport,
		private readonly createId: () => string = createClientCommandId,
	) {}

	start(input: Omit<StartChatParams, 'clientRequestId' | 'clientMessageId'>) {
		const request = this.#withMessageIdentity(input);
		return this.#prepared(request, () => this.transport.start(request));
	}

	run(input: Omit<AgentRunCommandRequest, 'clientRequestId' | 'clientMessageId'>) {
		const request = this.#withMessageIdentity(input);
		return this.#prepared(request, () => this.transport.run(request));
	}

	fork(input: Omit<ForkRunCommandRequest, 'clientRequestId' | 'clientMessageId'>) {
		const request = this.#withMessageIdentity(input);
		return this.#prepared(request, () => this.transport.fork(request));
	}

	enqueue(input: Omit<QueueEntryCreateCommandRequest, 'clientRequestId'>) {
		const request = { ...input, clientRequestId: this.createId() };
		return this.#prepared(request, () => this.transport.enqueue(request));
	}

	active(input: Omit<ActiveInputCommandRequest, 'clientRequestId'>) {
		const request = { ...input, clientRequestId: this.createId() };
		return this.#prepared(request, () => this.transport.active(request));
	}

	#withMessageIdentity<T extends object>(input: T): T & {
		clientRequestId: string;
		clientMessageId: string;
	} {
		return {
			...input,
			clientRequestId: this.createId(),
			clientMessageId: this.createId(),
		};
	}

	#prepared<T extends { clientRequestId: string; clientMessageId?: string }, R>(
		request: T,
		submit: () => Promise<R>,
	): PreparedAcceptedInput<R> & Pick<T, 'clientMessageId'> {
		return {
			clientRequestId: request.clientRequestId,
			...(request.clientMessageId ? { clientMessageId: request.clientMessageId } : {}),
			submit: () => submitIdempotentCommand(submit),
		};
	}
}
