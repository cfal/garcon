import { copyToClipboard } from '$lib/utils/clipboard';

export class ChatClipboardFeedback {
	copied = $state(false);
	#generation = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;

	async copy(value: string | null, container?: Element): Promise<void> {
		if (!value) return;
		const generation = ++this.#generation;
		const isCurrent = () => generation === this.#generation;
		if (!(await copyToClipboard(value, container, isCurrent)) || !isCurrent()) return;
		this.copied = true;
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.copied = false;
			this.#timer = undefined;
		}, 2000);
	}

	reset(): void {
		this.#generation++;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.copied = false;
	}
}
