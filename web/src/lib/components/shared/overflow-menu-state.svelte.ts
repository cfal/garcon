export class OverflowMenuState {
	open = $state(false);
	#afterClose?: () => void;

	constructor(private readonly onOpen?: () => void) {}

	setOpen = (open: boolean): void => {
		this.open = open;
		if (open) {
			this.#afterClose = undefined;
			this.onOpen?.();
		}
	};

	closeThen = (afterClose: () => void): void => {
		this.#afterClose = afterClose;
		this.open = false;
	};

	onCloseAutoFocus = (event: Event): void => {
		if (!this.#afterClose) return;
		event.preventDefault();
		// The parent focus scope resumes after the close-autofocus handler returns.
		queueMicrotask(this.#afterClose);
		this.#afterClose = undefined;
	};
}
