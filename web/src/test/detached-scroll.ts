export function emulateDetachedScrollReset(element: HTMLElement): void {
	let scrollLeft = element.scrollLeft;
	let scrollTop = element.scrollTop;
	Object.defineProperties(element, {
		scrollLeft: {
			configurable: true,
			get: () => (element.isConnected ? scrollLeft : 0),
			set: (value: number) => (scrollLeft = value),
		},
		scrollTop: {
			configurable: true,
			get: () => (element.isConnected ? scrollTop : 0),
			set: (value: number) => (scrollTop = value),
		},
	});
}
