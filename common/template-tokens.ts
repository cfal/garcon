const TEMPLATE_TOKEN_PATTERN = /\\?\{\{([a-z_][a-z0-9_]*)\}\}/g;

export const CHAT_ID_TEMPLATE_VARIABLE = 'chat_id' as const;
export const CHAT_ID_TEMPLATE_TOKEN = '{{chat_id}}';

export interface TemplateTokenMatch<Variable extends string> {
  index: number;
  raw: string;
  variable: Variable;
  escaped: boolean;
}

export class TemplateExpansionTooLongError extends Error {
  constructor(readonly maxLength: number) {
    super(`Expanded template exceeds ${maxLength} characters`);
    this.name = 'TemplateExpansionTooLongError';
  }
}

export function* matchTemplateTokens<Variable extends string>(
  template: string,
  allowedVariables: readonly Variable[],
): Generator<TemplateTokenMatch<Variable>> {
  const allowed = new Set<string>(allowedVariables);
  for (const match of template.matchAll(TEMPLATE_TOKEN_PATTERN)) {
    const variable = match[1];
    if (!variable || !allowed.has(variable)) continue;
    const raw = match[0];
    yield {
      index: match.index,
      raw,
      variable: variable as Variable,
      escaped: raw.startsWith('\\'),
    };
  }
}

export function expandTemplate<Variable extends string>(
  template: string,
  allowedVariables: readonly Variable[],
  values: Readonly<Record<Variable, string>>,
  maxLength: number,
): string {
  const chunks: string[] = [];
  let length = 0;
  let cursor = 0;

  const append = (value: string): void => {
    length += value.length;
    if (length > maxLength) throw new TemplateExpansionTooLongError(maxLength);
    chunks.push(value);
  };

  for (const match of matchTemplateTokens(template, allowedVariables)) {
    append(template.slice(cursor, match.index));
    append(match.escaped ? match.raw.slice(1) : values[match.variable]);
    cursor = match.index + match.raw.length;
  }

  append(template.slice(cursor));
  return chunks.join('');
}
