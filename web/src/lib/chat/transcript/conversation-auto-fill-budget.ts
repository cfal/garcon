import { TranscriptReadBudget, TRANSCRIPT_READ_REQUEST_LIMIT } from './transcript-read-budget.js';

export class ConversationAutoFillBudget {
	#chatId: string | null = null;
	#transcriptViewId: string | null = null;
	#admittedDemands = 0;

	reads = new TranscriptReadBudget();

	startView(chatId: string, transcriptViewId: string): void {
		if (this.#chatId !== chatId || this.#transcriptViewId !== transcriptViewId) {
			this.#chatId = chatId;
			this.#transcriptViewId = transcriptViewId;
			this.#admittedDemands = 0;
			this.reads = new TranscriptReadBudget();
		}
	}

	admitDemand(): boolean {
		if (this.reads.exhausted || this.#admittedDemands >= TRANSCRIPT_READ_REQUEST_LIMIT) return false;
		this.#admittedDemands += 1;
		return true;
	}
}
