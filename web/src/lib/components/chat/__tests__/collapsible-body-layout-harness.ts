import { vi } from 'vitest';

const BODY_SLOT = 'collapsible-body';
const CONTENT_SLOT = 'collapsible-body-content';

type HeightProperty = 'clientHeight' | 'clientWidth' | 'offsetHeight' | 'scrollHeight';

function propertyGetter(property: HeightProperty): (() => number) | undefined {
	let prototype: object | null = HTMLDivElement.prototype;
	while (prototype) {
		const getter = Object.getOwnPropertyDescriptor(prototype, property)?.get;
		if (getter) return getter;
		prototype = Object.getPrototypeOf(prototype);
	}
	return undefined;
}

export class CollapsibleBodyLayoutHarness {
	contentHeight = 240;
	collapsedHeight = 160;
	tallCollapsedHeight = 256;
	childMarginHeight = 0;
	width = 600;

	install(): void {
		const clientHeight = propertyGetter('clientHeight');
		const clientWidth = propertyGetter('clientWidth');
		const offsetHeight = propertyGetter('offsetHeight');
		const scrollHeight = propertyGetter('scrollHeight');
		const readContentHeight = () => this.contentHeight;
		const readCollapsedHeight = (element: HTMLDivElement) =>
			element.classList.contains('collapsible-body-tall')
				? this.tallCollapsedHeight
				: this.collapsedHeight;
		const readChildMarginHeight = () => this.childMarginHeight;
		const readWidth = () => this.width;
		const hasContainedChildMargin = (element: HTMLDivElement) =>
			element.querySelector<HTMLElement>(`[data-slot="${CONTENT_SLOT}"]`)?.classList.contains('flow-root') ??
			false;
		const bodyContentHeight = (element: HTMLDivElement) =>
			readContentHeight() +
			(hasContainedChildMargin(element) || element.classList.contains('collapsible-body-collapsed')
				? readChildMarginHeight()
				: 0);

		vi.spyOn(HTMLDivElement.prototype, 'clientHeight', 'get').mockImplementation(function (
			this: HTMLDivElement,
		) {
			if (this.dataset.slot !== BODY_SLOT) return clientHeight?.call(this) ?? 0;
			const naturalHeight = bodyContentHeight(this);
			return this.classList.contains('collapsible-body-collapsed')
				? Math.min(naturalHeight, readCollapsedHeight(this))
				: naturalHeight;
		});
		vi.spyOn(HTMLDivElement.prototype, 'clientWidth', 'get').mockImplementation(function (
			this: HTMLDivElement,
		) {
			return this.dataset.slot === BODY_SLOT ? readWidth() : (clientWidth?.call(this) ?? 0);
		});
		vi.spyOn(HTMLDivElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
			this: HTMLDivElement,
		) {
			return this.dataset.slot === CONTENT_SLOT
				? readContentHeight() +
						(this.classList.contains('flow-root') ? readChildMarginHeight() : 0)
				: (offsetHeight?.call(this) ?? 0);
		});
		vi.spyOn(HTMLDivElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
			this: HTMLDivElement,
		) {
			return this.dataset.slot === BODY_SLOT
				? bodyContentHeight(this)
				: (scrollHeight?.call(this) ?? 0);
		});
	}
}
