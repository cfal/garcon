// Re-serializing a whole draft rewrites text the user never touched, so each top-level node
// parsed from the draft keeps its exact source and only edited nodes are serialized again.

export type ComposerMarkdownBlock<T> =
	| { /** Exact source of an unedited node. */ source: string; /** Its position when parsed. */ index: number }
	| { /** A run of edited or inserted nodes. */ nodes: T[] };

/**
 * Splits the current top-level nodes into unedited nodes and edited runs. A null source marks a
 * node that could not be traced to its own source and is always serialized.
 */
export function planComposerMarkdownBlocks<T>(
	original: readonly T[],
	sources: readonly (string | null)[],
	current: readonly T[],
	equals: (a: T, b: T) => boolean,
): ComposerMarkdownBlock<T>[] {
	const originalIndices = new Map<T, number>();
	original.forEach((node, index) => originalIndices.set(node, index));
	const limit = Math.min(original.length, current.length);
	const unedited = (originalIndex: number, currentIndex: number) => {
		if (sources[originalIndex] === null) return false;
		const retainedIndex = originalIndices.get(current[currentIndex]);
		// Retained nodes keep their own source, even when another block is structurally equal.
		if (retainedIndex !== undefined) return retainedIndex === originalIndex;
		return equals(original[originalIndex], current[currentIndex]);
	};
	let prefix = 0;
	while (prefix < limit && unedited(prefix, prefix)) prefix += 1;
	let suffix = 0;
	while (
		suffix < limit - prefix &&
		unedited(original.length - 1 - suffix, current.length - 1 - suffix)
	) {
		suffix += 1;
	}
	const blocks: ComposerMarkdownBlock<T>[] = [];
	current.forEach((node, position) => {
		let index: number | undefined;
		if (position < prefix) index = position;
		else if (position >= current.length - suffix) {
			index = original.length - (current.length - position);
		} else index = originalIndices.get(node);
		const source = index === undefined ? null : sources[index];
		if (index !== undefined && source !== null) {
			originalIndices.delete(node);
			blocks.push({ source, index });
			return;
		}
		const last = blocks.at(-1);
		if (last && 'nodes' in last) last.nodes.push(node);
		else blocks.push({ nodes: [node] });
	});
	return blocks;
}

/**
 * Joins unedited sources and serialized runs. A source keeps its own trailing whitespace next to
 * its original neighbour or when it already ends in a blank line, which separates any two blocks.
 */
export function joinComposerMarkdownBlocks<T>(
	blocks: readonly ComposerMarkdownBlock<T>[],
	originalCount: number,
	serialize: (nodes: T[]) => string,
): string {
	let output = '';
	blocks.forEach((block, position) => {
		const next = blocks[position + 1];
		if ('nodes' in block) {
			output += serialize(block.nodes) + (next ? '\n\n' : '');
		} else if (next && 'index' in next && next.index === block.index + 1) {
			output += block.source;
		} else if (next) {
			output += block.source.endsWith('\n\n')
				? block.source
				: block.source.replace(/\n*$/, '\n\n');
		} else {
			output +=
				block.index === originalCount - 1 ? block.source : block.source.replace(/\n+$/, '');
		}
	});
	return output;
}
