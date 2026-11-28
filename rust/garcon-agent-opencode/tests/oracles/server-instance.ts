// Re-exports the two pure functions of `server-instance.ts` for recorded
// inputs. Every input names all three arguments: the defaults read the live
// environment, the checked-in plugin, and the platform, none of which repeat
// between machines.

export {
  buildOpenCodeServerEnv,
  mergeOpenCodeConfigContent,
} from "../../../../server-agents/opencode/src/agents/opencode/server-instance.ts";
