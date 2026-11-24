import { createContext } from 'svelte';
import type { ComposerQuestion } from './composer-question.js';

export interface ComposerQuestionPresentation {
	readonly question: ComposerQuestion | null;
}

export const [getComposerQuestionPresentation, setComposerQuestionPresentation, hasComposerQuestionPresentation] =
	createContext<ComposerQuestionPresentation>();
