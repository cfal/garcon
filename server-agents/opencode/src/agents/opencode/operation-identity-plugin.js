const OPERATION_PART_METADATA_KEY = 'garcon_operation_part_id';

const CONTINUATION_PROMPT =
  'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.';
const OVERFLOW_PREFIX =
  'The previous request exceeded the provider\'s size limit due to large media attachments. '
  + 'The conversation was compacted and media files were removed from context. '
  + 'If the user was asking about attached images or files, explain that the attachments '
  + 'were too large to process and suggest they try again with smaller or fewer files.\n\n';

function operationPartId(parts) {
  for (const part of parts) {
    const value = part?.metadata?.[OPERATION_PART_METADATA_KEY];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

function sessionIdFromEvent(event) {
  const value = event?.properties?.sessionID;
  return typeof value === 'string' && value ? value : null;
}

export const GarconOperationIdentityPlugin = async ({ client, directory }) => {
  const activeOperationParts = new Map();

  return {
    async 'chat.message'(input, output) {
      const partId = operationPartId(output.parts);
      if (partId) activeOperationParts.set(input.sessionID, partId);
    },

    async 'experimental.compaction.autocontinue'(input, output) {
      const partId = activeOperationParts.get(input.sessionID);
      if (!partId) return;

      const result = await client.session.prompt({
        path: { id: input.sessionID },
        query: { directory },
        body: {
          agent: input.message.agent,
          model: input.message.model,
          noReply: true,
          parts: [{
            type: 'text',
            text: `${input.overflow ? OVERFLOW_PREFIX : ''}${CONTINUATION_PROMPT}`,
            synthetic: true,
            metadata: { [OPERATION_PART_METADATA_KEY]: partId },
          }],
        },
      });
      if (result?.error) {
        throw new Error('OpenCode rejected Garcon\'s operation-qualified compaction continuation');
      }
      output.enabled = false;
    },

    async event({ event }) {
      const sessionId = sessionIdFromEvent(event);
      if (!sessionId) return;
      if (
        event.type === 'session.deleted'
        || (event.type === 'session.status' && event.properties?.status?.type === 'idle')
      ) activeOperationParts.delete(sessionId);
    },

    async dispose() {
      activeOperationParts.clear();
    },
  };
};
