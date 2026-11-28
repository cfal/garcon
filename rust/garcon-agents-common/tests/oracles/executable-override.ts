import { resolveExecutableOverride as originalResolveExecutableOverride } from "../../../../server-agents/common/src/environment/executable-override.ts";

// A relative command resolves against the working directory, which is fixed
// to the root so that a recording does not depend on the machine.
process.chdir("/");

export const resolveExecutableOverride = (command: string, platform: NodeJS.Platform | null | undefined) =>
  originalResolveExecutableOverride(command, platform ?? undefined);
