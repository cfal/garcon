import { createContext } from 'svelte';
import type { AsyncQuestionController } from './async-question-controller.svelte.js';
import type { AsyncQuestionTarget } from './async-question-submission.js';

export const [getAsyncQuestionController, setAsyncQuestionController] = createContext<AsyncQuestionController>();

export interface AsyncQuestionPanelPort {
	readonly controller: AsyncQuestionController;
	readonly identity: AsyncQuestionTarget;
	canReply(ordinal: number): boolean;
	canSubmit(ordinal: number): boolean;
	recordedAnswer(ordinal: number, questionId: string): string | undefined;
}

export const [getAsyncQuestionPanel, setAsyncQuestionPanel, hasAsyncQuestionPanel] = createContext<AsyncQuestionPanelPort>();
