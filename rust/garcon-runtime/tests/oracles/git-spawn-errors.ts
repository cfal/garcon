import { runGit } from '../../../../server/runtime/git/run.js';
import { gitServiceError } from '../../../../server/runtime/git/service-errors.js';

if (Bun.version !== '1.4.3') throw new Error('The Git spawn oracle requires the pinned Bun 1.4.3');

const cases = JSON.parse(await Bun.stdin.text()) as { cwd: string; path: string | null }[];
const results = [];
for (const { cwd, path } of cases) {
  try {
    await runGit(cwd, ['--version'], path === null ? {} : { env: { PATH: path } });
    throw new Error('Expected the Git spawn to fail');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error)) throw error;
    const mapped = gitServiceError(error);
    if (!('code' in mapped)) throw mapped;
    results.push({ code: error.code, message: error.message, serviceCode: mapped.code, serviceMessage: mapped.message });
  }
}
console.log(JSON.stringify(results));
