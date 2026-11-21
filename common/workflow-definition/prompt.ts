import type { JsonValue } from '../json.js';

const PLACEHOLDER = /\{\{[ \t]*([A-Za-z0-9][A-Za-z0-9_-]{0,127})[ \t]*\}\}/gu;

export function workflowPromptBindingNames(prompt: string): Set<string> {
  return new Set(Array.from(prompt.matchAll(PLACEHOLDER), (match) => match[1]));
}

/** Substitutes declared names once. A replacement value is never interpreted as a template. */
export function renderWorkflowPrompt(prompt: string, values: Readonly<Record<string, JsonValue>>): string {
  return prompt.replace(PLACEHOLDER, (_, name: string) => {
    if (!Object.hasOwn(values, name)) throw new Error(`Missing workflow prompt binding ${JSON.stringify(name)}.`);
    const value = values[name];
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}
