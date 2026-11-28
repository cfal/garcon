import { mkdir, readFile, readdir, readlink, stat } from "node:fs/promises";
import { diagnosticErrorCode, hasNodeErrorCode } from "../../../server/common/errors.ts";

if (Bun.version !== "1.4.3") throw new Error("Expected Bun 1.4.3, got " + Bun.version);
const [, , missing, directory, file] = process.argv;
const results = [];
for (const run of [
  () => stat(missing),
  () => mkdir(directory),
  () => readdir(file),
  () => readFile(directory),
  () => readlink(file),
  () => stat(file + "/child"),
]) {
  try {
    await run();
    throw new Error("fixture operation unexpectedly succeeded");
  } catch (error) {
    if (typeof error?.code !== "string") throw error;
    results.push({ code: diagnosticErrorCode(error), recognized: hasNodeErrorCode(error, error.code) });
  }
}
console.log(JSON.stringify(results));
