import { CST, isMap, isScalar, isSeq, stringify, type Node } from 'yaml';
import type { JsonValue } from '../json.js';
import type { WorkflowField, WorkflowSource } from './source.js';
import { WORKFLOW_DEFINITION_LIMITS, type WorkflowDefinitionEdit, type WorkflowFieldPath } from './types.js';

type Collection = CST.BlockMap | CST.BlockSequence | CST.FlowCollection;
type Item = CST.CollectionItem;
type Patch = { start: number; end: number; text: string };

export function applyWorkflowEdit(root: WorkflowField, edit: WorkflowDefinitionEdit): string | null {
  const { source } = root;
  const fail = (message: string) => {
    source.issue('invalid-edit', edit.path, message);
    return null;
  };
  const kind = 'kind' in edit ? edit.kind : 'upsert';
  const path = edit.path;
  const insert = kind === 'append' || kind === 'insert';
  const parentPath = insert ? path : path.slice(0, -1);
  const parent = source.nodeAt(parentPath);
  const collection = parent?.srcToken;
  if (!CST.isCollection(collection) || (!isMap(parent) && !isSeq(parent)) || (!insert && !path.length)) {
    return fail('Choose an existing YAML mapping or list to edit.');
  }
  const entries = collection.items.filter((item) => isEntry(collection, item));
  const key = insert ? undefined : path.at(-1);
  const index = isMap(parent) ? entries.findIndex((item) => CST.resolveAsScalar(item.key)?.value === key)
    : typeof key === 'number' && Number.isInteger(key) ? key : -1;
  const item = index >= 0 ? entries[index] : undefined;

  if ('kind' in edit && edit.kind === 'delete') {
    if (!item) return fail('Choose an existing field or list item to remove.');
    const patches = collection.type === 'flow-collection'
      ? deleteFlow(source, path, collection, entries, index)
      : [deleteBlock(source.text, collection, entries, item)];
    return patchSource(source.text, patches);
  }
  if (!('value' in edit)) return fail('Supply a YAML value for the edit.');
  if (!('kind' in edit) && !isScalar(source.nodeAt(path))) return fail('Choose an existing scalar field to edit.');
  const json = encodeValue(edit.value);
  if (json === undefined) return fail('Use JSON-compatible values within the workflow source limit.');

  if ('kind' in edit && (edit.kind === 'append' || edit.kind === 'insert')) {
    if (!isSeq(parent)) return fail('Choose a list to insert into.');
    const at = edit.kind === 'append' ? entries.length : edit.index;
    if (!Number.isInteger(at) || at < 0 || at > entries.length) return fail('Choose an insertion index within the list.');
    return insertEntry(source, parentPath, collection, entries, at, json);
  }
  if (!item) {
    if (!isMap(parent) || typeof key !== 'string') return fail('Choose an existing list item or name a mapping field.');
    return insertEntry(source, parentPath, collection, entries, entries.length, json, key);
  }
  const node = source.nodeAt(path);
  if (!node?.range) return fail('Choose an existing YAML value to replace.');
  if (JSON.stringify(root.atPath(path).value) === json) return source.text;
  return patchSource(source.text, [replaceValue(source.text, node, json)]);
}

function encodeValue(value: JsonValue): string | undefined {
  try {
    const json = JSON.stringify(value, (_, item: unknown) => {
      if (typeof item === 'number' && (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))) {
        throw new TypeError('Not a safe JSON number');
      }
      return item;
    });
    return json && json.length <= WORKFLOW_DEFINITION_LIMITS.sourceBytes ? json : undefined;
  } catch {
    return undefined;
  }
}

function isEntry(collection: Collection, item: Item): boolean {
  if (collection.type === 'block-seq') return item.start.some((token) => token.type === 'seq-item-ind');
  return item.key != null || item.value != null;
}

function itemStart(item: Item): number {
  return item.start.find((token) => token.type === 'seq-item-ind' || token.type === 'explicit-key-ind')?.offset
    ?? item.key?.offset ?? item.value!.offset;
}

function itemEnd(item: Item, source: string): number {
  const text = CST.stringify(item);
  const end = (item.start[0]?.offset ?? itemStart(item)) + text.length;
  if (end === source.length) return end;
  // YAML can attach the next sibling's indentation to a trailing comment.
  return end - (/\n([ \t]+)$/u.exec(text)?.[1].length ?? 0);
}

function lineStart(text: string, position: number): number {
  return position > 0 ? text.lastIndexOf('\n', position - 1) + 1 : 0;
}

function eolAt(text: string, position: number): string {
  const next = text.indexOf('\n', position);
  const end = next < 0 ? text.lastIndexOf('\n', position) : next;
  return end > 0 && text[end - 1] === '\r' ? '\r\n' : '\n';
}

function replaceValue(text: string, node: Node, json: string): Patch {
  const [start, end] = node.range!;
  const token = node.srcToken;
  if (token?.type === 'block-scalar') {
    const value: JsonValue = JSON.parse(json);
    if (typeof value === 'string' && !value.endsWith('\n\n')) {
      const newline = token.props.find((part) => part.type === 'newline');
      const replacement = structuredClone(token);
      CST.setScalarValue(replacement, value, { afterKey: true });
      if (newline && replacement.type === 'block-scalar' && CST.resolveAsScalar(replacement)?.value === value) {
        if ('source' in newline && newline.source === '\r\n') replacement.source = replacement.source.replaceAll('\n', '\r\n');
        return { start, end, text: CST.stringify(replacement) };
      }
    }
    // The header comment and line break are inside a block scalar's value range.
    const suffix = token.props.slice(1).map(CST.stringify).join('');
    return { start, end, text: json + suffix };
  }
  if (start === end) {
    const before = /[:-]/u.test(text[start - 1] ?? '') ? ' ' : '';
    const after = text[start] === '#' ? ' ' : '';
    return { start, end, text: before + json + after };
  }
  const newline = (token?.type === 'block-map' || token?.type === 'block-seq') && text[end - 1] === '\n';
  return { start, end, text: json + (newline ? eolAt(text, end - 1) : '') };
}

function deleteBlock(text: string, collection: CST.BlockMap | CST.BlockSequence, entries: Item[], item: Item): Patch {
  const contentStart = itemStart(item);
  const leadingStart = lineStart(text, contentStart);
  const inline = text.slice(leadingStart, contentStart).trim() !== '';
  const start = inline ? contentStart : leadingStart;
  const end = itemEnd(item, text);
  if (entries.length > 1) return { start, end, text: inline ? eolAt(text, end - 1) : '' };
  const empty = collection.type === 'block-map' ? '{}' : '[]';
  const indent = inline ? '' : text.slice(leadingStart, contentStart);
  return { start, end, text: indent + empty + (text[end - 1] === '\n' ? eolAt(text, end - 1) : '') };
}

function deleteFlow(source: WorkflowSource, path: WorkflowFieldPath, collection: CST.FlowCollection, entries: Item[], index: number): Patch[] {
  const item = entries[index];
  const start = itemStart(item);
  const end = source.nodeAt(path)?.range?.[1] ?? start;
  const patches: Patch[] = [{ start, end, text: '' }];
  const separator = index > 0 ? item : entries[1] ?? collection.items[collection.items.indexOf(item) + 1];
  const comma = separator?.start.find((token) => token.type === 'comma');
  if (comma) {
    let after = comma.offset + 1;
    const spacing = /^[ \t]*/u.exec(source.text.slice(after))?.[0] ?? '';
    if (!/[#\r\n]/u.test(source.text[after + spacing.length] ?? '')) after += spacing.length;
    patches.push({ start: comma.offset, end: after, text: source.text[after] === '#' && !spacing ? ' ' : '' });
  }
  return patches;
}

function insertEntry(
  source: WorkflowSource, path: WorkflowFieldPath, collection: Collection, entries: Item[], index: number, json: string, key?: string,
): string {
  const current = entries[index];
  if (collection.type === 'flow-collection') {
    const entry = key === undefined ? json : `${JSON.stringify(key)}: ${json}`;
    if (current) return patchSource(source.text, [{ start: itemStart(current), end: itemStart(current), text: `${entry}, ` }]);
    const close = collection.end[0].offset;
    const last = entries.at(-1);
    if (!last) return patchSource(source.text, [{ start: collection.start.offset + 1, end: collection.start.offset + 1, text: entry }]);
    const lastKey = key === undefined ? entries.length - 1 : CST.resolveAsScalar(last.key)!.value;
    const end = source.nodeAt([...path, lastKey])!.range![1];
    const tail = source.text.slice(end, close);
    if (!/[#\r\n]/u.test(tail)) return patchSource(source.text, [{ start: end, end, text: `, ${entry}` }]);
    const comma = collection.items.slice(collection.items.indexOf(last) + 1)
      .some((item) => item.start.some((token) => token.type === 'comma'));
    const prefix = source.text.slice(lineStart(source.text, close), close);
    const padding = Math.max(0, collection.indent + 2 - prefix.length);
    const text = prefix.trim() === '' ? `${' '.repeat(padding)}${entry}${eolAt(source.text, close)}${prefix}` : ` ${entry}`;
    return patchSource(source.text, [{ start: close, end: close, text }, ...(comma ? [] : [{ start: end, end, text: ',' }])]);
  }
  const last = entries.at(-1);
  const before = current ? lineStart(source.text, current.start[0]?.offset ?? itemStart(current))
    : last ? itemEnd(last, source.text) : collection.offset;
  const eol = eolAt(source.text, before);
  const value: JsonValue = JSON.parse(json);
  const rendered = stringify(key === undefined ? [value] : { [key]: value }, { lineWidth: 0 });
  const indent = ' '.repeat(collection.indent);
  const entry = rendered.slice(0, -1).split('\n').map((line) => line ? indent + line : '').join(eol);
  const needsSeparator = !current && before > 0 && source.text[before - 1] !== '\n';
  const needsTrailingBreak = before < source.text.length || source.text.endsWith('\n');
  return patchSource(source.text, [{ start: before, end: before,
    text: `${needsSeparator ? eol : ''}${entry}${needsTrailingBreak ? eol : ''}` }]);
}

function patchSource(text: string, patches: Patch[]): string {
  for (const patch of patches.sort((a, b) => b.start - a.start || b.end - a.end)) {
    text = text.slice(0, patch.start) + patch.text + text.slice(patch.end);
  }
  return text;
}
