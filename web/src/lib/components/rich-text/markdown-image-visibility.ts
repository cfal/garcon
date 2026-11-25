type VisibilityHandler = (nearby: boolean) => void;
const observers = new Map<
	HTMLElement | null,
	{
		observer: IntersectionObserver;
		targets: Map<Element, VisibilityHandler>;
	}
>();

let rootsThisTurn: WeakMap<HTMLElement, HTMLElement | null> | undefined;

function imageScrollRoot(target: HTMLElement): HTMLElement | null {
	// Shares ancestor checks within a mount batch without retaining roots across style changes.
	if (!rootsThisTurn) {
		rootsThisTurn = new WeakMap();
		queueMicrotask(() => {
			rootsThisTurn = undefined;
		});
	}
	const roots = rootsThisTurn;
	const visited: HTMLElement[] = [];
	let root: HTMLElement | null = null;
	for (let parent = target.parentElement; parent; parent = parent.parentElement) {
		const cached = roots.get(parent);
		if (cached !== undefined) {
			root = cached;
			break;
		}
		visited.push(parent);
		const style = getComputedStyle(parent);
		if (/(auto|scroll|overlay)/.test(`${style.overflowX} ${style.overflowY}`)) {
			root = parent;
			break;
		}
	}
	for (const parent of visited) roots.set(parent, root);
	return root;
}

export function observeMarkdownImage(
	target: HTMLElement,
	onVisibility: VisibilityHandler,
): () => void {
	const root = imageScrollRoot(target);
	let pool = observers.get(root);
	if (!pool) {
		const targets = new Map<Element, VisibilityHandler>();
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) targets.get(entry.target)?.(entry.isIntersecting);
			},
			{ root, rootMargin: '400px' },
		);
		pool = { observer, targets };
		observers.set(root, pool);
	}
	const { observer, targets } = pool;
	targets.set(target, onVisibility);
	observer.observe(target);
	return () => {
		if (targets.get(target) !== onVisibility) return;
		targets.delete(target);
		observer.unobserve(target);
		if (targets.size === 0) {
			observer.disconnect();
			observers.delete(root);
		}
	};
}
