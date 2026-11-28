/**
 * Propagates each OpenCode shell invocation's native session identity.
 *
 * The hook remains stateless because one OpenCode process may serve concurrent,
 * resumed, forked, and child sessions.
 */
export const GarconSessionIdentity = async () => ({
  'shell.env': async ({ sessionID }, output) => {
    // Removes prior hook values so an unidentified invocation cannot inherit stale identity.
    delete output.env.OPENCODE_SESSION_ID;
    if (sessionID) {
      output.env.OPENCODE_SESSION_ID = sessionID;
    }
  },
});
