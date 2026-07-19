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

type InputFactory<T> = T | (() => T);

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

	start(input: InputFactory<Omit<StartChatParams, 'clientRequestId' | 'clientMessageId'>>) {
		return this.#messageSubmission(input, (request) => this.transport.start(request));
	}

	run(input: Omit<AgentRunCommandRequest, 'clientRequestId' | 'clientMessageId'>) {
		return this.#messageSubmission(input, (request) => this.transport.run(request));
	}

	fork(input: Omit<ForkRunCommandRequest, 'clientRequestId' | 'clientMessageId'>) {
		return this.#messageSubmission(input, (request) => this.transport.fork(request));
	}

	enqueue(input: Omit<QueueEntryCreateCommandRequest, 'clientRequestId'>) {
		const request = { ...input, clientRequestId: this.createId() };
		return this.#prepared(request, () => this.transport.enqueue(request));
	}

	active(input: Omit<ActiveInputCommandRequest, 'clientRequestId'>) {
		const request = { ...input, clientRequestId: this.createId() };
		return this.#prepared(request, () => this.transport.active(request));
	}

	#messageSubmission<T extends object, R>(
		input: InputFactory<T>,
		submit: (request: T & { clientRequestId: string; clientMessageId: string }) => Promise<R>,
	): PreparedAcceptedInput<R> & { clientMessageId: string } {
		const clientRequestId = this.createId();
		const clientMessageId = this.createId();
		let request: T & { clientRequestId: string; clientMessageId: string } | undefined;
		return {
			clientRequestId,
			clientMessageId,
			submit: () => submitIdempotentCommand(() => {
				request ??= {
					...(typeof input === 'function' ? input() : input),
					clientRequestId,
					clientMessageId,
				};
				return submit(request);
			}),
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
