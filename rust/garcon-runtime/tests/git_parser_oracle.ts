import { parseNameStatusZ, parseNumstatZ } from '../../../server/runtime/git/diff-file-list.js';

if (Bun.version !== '1.4.3') throw new Error('The Git parser oracle requires the pinned Bun 1.4.3');
const { numstat, nameStatus } = JSON.parse(await Bun.stdin.text()) as { numstat: string; nameStatus: string };
const stats = parseNumstatZ(numstat);
console.log(JSON.stringify({ stats, files: parseNameStatusZ(nameStatus, stats) }));
