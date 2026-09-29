# Local Models in Garcon

Garcon runs local models through custom API providers. Add an Ollama provider,
fetch its models, and pick one in the model picker like any other provider
model. The same flow works for any OpenAI-compatible or Anthropic
Messages-compatible local server; Ollama has built-in templates.

Local models are available to:

- Claude Code and Direct Chat, through an Anthropic Messages endpoint;
- Codex and Direct Chat, through an OpenAI-compatible endpoint. Codex requires
  Responses API support, which the Ollama template declares.

## Prerequisites

- Ollama installed and running on the machine that runs the agent: the Local
  executor, or the remote executor that will run the chat.
- At least one pulled model, for example `ollama pull llama3.1:8b`.

`curl http://localhost:11434/api/tags` on that machine should list the pulled
models.

## Add An Ollama Provider

1. Open Server Settings > Providers.
2. Under Custom Providers, open Add provider in the Anthropic Providers or
   OpenAI Providers section and choose Add Ollama.
3. In the dialog, select the executor that will run the chats. Local is the
   default. The new provider is assigned to that executor only.
4. Keep the template URL (`http://localhost:11434` for Anthropic Messages,
   `http://localhost:11434/v1` for OpenAI-compatible) or point it at another
   Ollama host. Leave the API key blank for a local Ollama.
5. Select Fetch models. Garcon reads Ollama's `/api/tags` from the selected
   executor and labels each model `(local)`. Save the provider.

Other executors can use the same provider after you tick them in its executor
list. See [Custom Providers On Executors](./providers.md) for the assignment
and credential rules.

## Use A Local Model

Create a chat on an executor the provider is assigned to, choose the agent, and
pick a model ending in `(local)` under the provider.

The provider URL is resolved on the executor that runs the agent, so
`localhost` means that executor's machine, not necessarily the controller's.
Assigning a provider does not make an unreachable address reachable.

A chat cannot switch between a local and a cloud model mid-session; start a new
chat to change between them. This prevents replaying session history across
incompatible backends.

## Troubleshooting

### Local models do not appear

- Confirm Ollama is running on the executor: `curl http://localhost:11434/api/tags`.
- Confirm the provider is assigned to the chat's executor.
- Confirm the agent matches the provider's protocol: Claude Code with an
  Anthropic provider, Codex with an OpenAI provider.

### A newly pulled model is missing

Garcon stores the model list with the provider. Open the provider, select Fetch
models again, and save.
