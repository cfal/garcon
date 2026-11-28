// Computes what Node's `pathToFileURL(path).href` answers for recorded
// absolute paths, which the port of `resolveSessionIdentityPluginUrl` builds
// its file URL with.

import { pathToFileURL } from "node:url";

export function fileUrl(path: string) {
  return pathToFileURL(path).href;
}
