import { isScalar } from 'yaml';
import type { WorkflowSource } from './source.js';
import { WORKFLOW_DEFINITION_LIMITS, type WorkflowFieldEdit } from './types.js';

export function applyWorkflowFieldEdits(source: WorkflowSource, edits: readonly WorkflowFieldEdit[]): string | null {
  const patches: { start: number; end: number; replacement: string; path: WorkflowFieldEdit['path'] }[] = [];
  let length = source.text.length;
  for (const { path, value } of edits) {
    const node = source.nodeAt(path);
    if (!isScalar(node) || !node.range) {
      source.issue('invalid-edit', path, 'Edit an existing scalar field. Use Source to add, remove, or replace collections.');
      return null;
    }
    if (value === node.value) continue;
    if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
      source.issue('invalid-edit', path, 'Use a finite JSON number and keep integers within the safe range.');
      return null;
    }
    const [start, end] = node.range;
    const rendered = JSON.stringify(value);
    const token = node.srcToken;
    // The header comment and line ending are inside the range of a block scalar.
    const replacement = token?.type === 'block-scalar'
      ? rendered + token.props.slice(1).map((part) => 'source' in part ? part.source : '').join('')
      : start === end
        ? `${source.text[start - 1]?.match(/[:-]/u) ? ' ' : ''}${rendered}${source.text[start] === '#' ? ' ' : ''}`
        : rendered;
    length += replacement.length - (end - start);
    patches.push({ start, end, replacement, path });
  }
  if (length > WORKFLOW_DEFINITION_LIMITS.sourceBytes) {
    source.issue('source-limit', [], `Keep workflow YAML within ${WORKFLOW_DEFINITION_LIMITS.sourceBytes} UTF-8 bytes.`);
    return null;
  }

  patches.sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let offset = 0;
  let previousStart = -1;
  for (const { start, end, replacement, path } of patches) {
    if (start < offset || start === previousStart) {
      source.issue('invalid-edit', path, 'Edit each field at most once per change.');
      return null;
    }
    parts.push(source.text.slice(offset, start), replacement);
    offset = end;
    previousStart = start;
  }
  parts.push(source.text.slice(offset));
  return parts.join('');
}
