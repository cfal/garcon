import type { JSONContent } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';

/** Caches fully restored Markdown, never per-serialization protection sentinels. */
export class ComposerMarkdownCache {
	#blockMarkdown = new WeakMap<Node, string>();
	#rowLines = new WeakMap<Node, string[]>();

	constructor(private readonly serialize: (document: JSONContent) => string) {}

	run(nodes: readonly Node[]): string {
		// Private-use text determines protection sentinels shared with resource destinations.
		if (nodes.some((node) => /[\uE000-\uF8FF]/.test(node.textContent))) {
			return this.serialize({ type: 'doc', content: nodes.map((node) => node.toJSON()) });
		}
		const blocks = nodes.filter(
			(node, index) => !this.#isEmptyParagraph(node) || !this.#isEmptyParagraph(nodes[index - 1]),
		);
		const rendered = blocks.map((node) => this.#block(node));
		// The codec discards whitespace-only output only when it is the entire document.
		if (rendered.some((source, index) => source === '' && !this.#isEmptyParagraph(blocks[index]))) {
			return this.serialize({ type: 'doc', content: nodes.map((node) => node.toJSON()) });
		}
		return rendered.join('\n\n');
	}

	#isEmptyParagraph(node: Node | undefined): boolean {
		return node?.type.name === 'paragraph' && node.childCount === 0;
	}

	#block(node: Node): string {
		const cached = this.#blockMarkdown.get(node);
		if (cached !== undefined) return cached;
		const source =
			node.type.name === 'table'
				? this.#table(node)
				: this.serialize({ type: 'doc', content: [node.toJSON()] });
		this.#blockMarkdown.set(node, source);
		return source;
	}

	#table(table: Node): string {
		const lines: string[] = [];
		table.forEach((row, _offset, index) => {
			let rendered = this.#rowLines.get(row);
			if (!rendered) {
				// A one-row table uses the same cell normalization and renderer as a full table.
				rendered = this.serialize({
					type: 'doc',
					content: [{ type: 'table', content: [row.toJSON()] }],
				}).split('\n');
				this.#rowLines.set(row, rendered);
			}
			lines.push(...(index === 0 ? rendered : rendered.slice(0, 1)));
		});
		return lines.join('\n');
	}
}
