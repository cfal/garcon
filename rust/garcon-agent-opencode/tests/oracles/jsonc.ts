// Computes what `jsonc-parser` 3.3.1, the package the original reads inherited
// configuration with, answers for recorded inputs: the value its fault
// tolerant `parse` builds and the first of its diagnostics, by the name its
// `printParseErrorCode` gives. The options are those of
// `mergeOpenCodeConfigContent`.

import { parse, printParseErrorCode } from "../../../../server-agents/opencode/node_modules/jsonc-parser/lib/esm/main.js";

export function parseJsonc(text: string) {
  const errors: Array<{ error: number; offset: number; length: number }> = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  return {
    count: errors.length,
    first: errors[0] === undefined
      ? null
      : { offset: errors[0].offset, length: errors[0].length, code: printParseErrorCode(errors[0].error) },
    hasValue: value !== undefined,
    value,
  };
}
