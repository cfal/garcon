// Removes model reasoning ("think") blocks from response text with a single
// scan over the tags, tracking nesting depth. Tolerant of malformed output:
// - Balanced blocks, including nested ones, are removed where they appear.
// - An opening tag that never closes removes everything through the end.
// - A closing tag with no prior opening tag is assumed to end reasoning
//   whose opening tag was lost upstream (e.g. emitted by the chat template
//   instead of the model), so it also removes everything before it.
// Tags match case-insensitively, with attributes and trailing whitespace.
const THINK_TAG_PATTERN = /<(\/?)think\b[^>]*>/gi;

export function stripThinkBlocks(text: string): string {
  let visible = '';
  let depth = 0;
  let flushFrom = 0;
  for (const match of text.matchAll(THINK_TAG_PATTERN)) {
    if (match[1] !== '/') {
      if (depth === 0) visible += text.slice(flushFrom, match.index);
      depth += 1;
    } else {
      if (depth > 0) depth -= 1;
      else visible = ''; // orphan close: everything before it was reasoning
      if (depth === 0) flushFrom = match.index + match[0].length;
    }
  }
  if (depth === 0) visible += text.slice(flushFrom);
  return visible.trim();
}
