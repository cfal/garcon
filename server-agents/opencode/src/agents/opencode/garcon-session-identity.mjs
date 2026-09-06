export const GarconSessionIdentity = async () => ({
  'shell.env': async ({ sessionID }, output) => {
    delete output.env.OPENCODE_SESSION_ID;
    if (sessionID) {
      output.env.OPENCODE_SESSION_ID = sessionID;
    }
  },
});
