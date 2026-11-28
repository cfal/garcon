import { readJsonlLineEntries } from '../../../../server-agents/common/src/shared/history-loader-utils.ts';

const path = Bun.argv[2]!;
const outcomes = [];
for (const options of [{}, { completeLinesOnly: true, includeEmptyLines: true }, { maxReadBytes: 10 }]) {
  const rows = [];
  let error: string | null = null;
  try {
    for await (const row of readJsonlLineEntries(path, options)) rows.push(row);
  } catch (cause) {
    error = (cause as Error).message;
  }
  outcomes.push({ rows, error });
}
process.stdout.write(JSON.stringify(outcomes));
