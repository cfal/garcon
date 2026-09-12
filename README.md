<p align="center">
  <img src="docs/brand/garcon-fork-tail-forest.svg" alt="" width="96" />
</p>
<h1 align="center">Garcon</h1>

<p align="center"><strong>Run the agents. See the work. Ship the change.</strong></p>

<p align="center">
  Garcon is a self-hosted visual workspace for coding agents. Run Claude Code, Codex, Cursor Agent, OpenCode, Amp, Factory Droid, and Pi side by side, coordinate their work, and move from prompt to reviewed commit without leaving the browser.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#why-garcon">Why Garcon</a> &middot;
  <a href="#see-it-in-action">See It In Action</a> &middot;
  <a href="#automate-and-delegate">Automate And Delegate</a>
</p>

<p align="center">
  <a href="screenshots/readme-agent-coordination-dark.png">
    <img src="screenshots/readme-agent-coordination-dark.png" alt="Garcon's dark windowed workspace showing a delegated agent result, Chat Map lineage across 33 chats, and project files" width="100%" />
  </a>
</p>

<p align="center"><em>Keep delegated results, chat lineage, files, terminals, and Git visible in one resizable workspace.</em></p>

Garcon runs agents, terminals, files, Git, and pull request commands on the host under your account, using the agent logins and model endpoints you configure.

## Quick Start

```bash
git clone https://github.com/cfal/garcon.git
cd garcon
bun run setup
bun run start
```

Open `http://127.0.0.1:8080`. On first launch, create an account at `/setup`, then connect agents and API providers in Settings. Authentication is enabled by default.

Requirements:

- [Bun](https://bun.sh/), `git`, and a modern browser.
- At least one working coding agent or API provider.
- Optional pull request support: an authenticated GitHub CLI on the Garcon host.

For a containerized install, set `GARCON_PROJECT_DIR`, `GARCON_UID`, and `GARCON_GID` in `.env`, then run `docker compose up --build -d`. The [Docker guide](docs/docker.md) covers volumes, agent login, Git, SSH, and toolchains.

## Why Garcon

One agent chat is easy. The hard part begins when several agents are running, one needs approval, another has finished, and their changes still need to be understood and shipped.

Garcon keeps that development loop coherent:

- **Orchestrate visually.** Tile up to four resizable windows, move local tabs between them, organize live chats on durable canvases, track work on tag-driven boards, and inspect fork, handoff, and delegation lineage in Chat Map.
- **Stay in control of every turn.** Queue and reorder instructions, steer active work, approve tools, answer agent questions, pause the queue, interrupt, or stop without losing the transcript.
- **Coordinate agents visibly.** Exchange provenance-labeled messages between chats, launch delegated children, receive their final results, and keep parentage auditable instead of hiding it in a side channel.
- **Review the real change.** Browse and edit files, run terminals, inspect reasoning and tool calls, review diffs, then stage individual lines, hunks, files, or folders before committing and pushing.
- **Find and reuse context.** Search chat metadata and indexed transcripts, save filters, tag, pin, archive, export Markdown or XML, build bounded handoffs, share snapshots, and schedule prompts.
- **Work from any screen.** Use the responsive workspace on desktop or phone and choose Classic, Phosphor, or colorblind-aware themes in light or dark mode.

## See It In Action

<p align="center">
  <a href="screenshots/readme-chat-canvas-dark.png">
    <img src="screenshots/readme-chat-canvas-dark.png" alt="Garcon Chat Canvas in dark mode with 24 content-rich chat cards arranged into connected Research, Implementation, Review, and Validation and Release boxes" width="100%" />
  </a>
</p>

<p align="center"><strong>Shape parallel work on a canvas.</strong> Group live chats into named boxes, connect related work, save multiple canvases, and switch to a structured list when that view fits better.</p>

<p align="center">
  <a href="screenshots/readme-chat-board-light.png">
    <img src="screenshots/readme-chat-board-light.png" alt="Garcon Chat Board in light mode with 32 detailed chats distributed across Backlog, In progress, Review, and Done columns" width="100%" />
  </a>
</p>

<p align="center"><strong>Turn live metadata into a delivery board.</strong> Define columns from chat filters and move work by applying the configured tag transitions.</p>

<p align="center">
  <a href="screenshots/readme-development-loop-dark.png">
    <img src="screenshots/readme-development-loop-dark.png" alt="Garcon's dark workspace showing a detailed agent chat, a passing test run in a terminal, and staged, unstaged, and untracked Git changes" width="100%" />
  </a>
</p>

<p align="center"><strong>Keep the development loop together.</strong> Follow the agent, run focused checks, inspect changed files, stage precisely, and commit from the same workspace.</p>

<table>
  <tr>
    <td width="50%" align="center">
      <a href="screenshots/readme-mobile-coordination-dark.png">
        <img src="screenshots/readme-mobile-coordination-dark.png" alt="Garcon on mobile showing a completed delegated agent review with detailed checks and bottom workspace navigation" width="100%" />
      </a>
    </td>
    <td width="50%" align="center">
      <a href="screenshots/readme-mobile-canvas-light.png">
        <img src="screenshots/readme-mobile-canvas-light.png" alt="Garcon Chat Canvas list view on mobile showing detailed chats in the Research workstream" width="100%" />
      </a>
    </td>
  </tr>
  <tr>
    <td align="center"><strong>Steer and unblock from anywhere.</strong></td>
    <td align="center"><strong>Carry the same visual plan to mobile.</strong></td>
  </tr>
</table>

## Works With

**Coding agents:** Claude Code, Codex, Cursor Agent, OpenCode, Amp, Factory Droid, and Pi.

**Direct model access:** Anthropic Messages, OpenAI Responses, and OpenAI Chat Completions compatible endpoints.

**Provider presets and discovery:** Ollama, OpenRouter, Gemini, Fireworks, Together, Alibaba Cloud, Z.AI, and custom OpenAI or Anthropic compatible services.

Use an existing agent login or subscription where its CLI supports one, or configure API providers in Settings. Each chat keeps its own agent, model, effort, permission, provider, endpoint, and preamble settings where supported.

Claude Code requires version 2.1.238 or newer. A model ending in `[Nk]` sets a per-chat auto-compaction window without a per-model configuration table. For example, `gpt-6-astra[922k]` launches Claude with `--model gpt-6-astra[1m] --autocompact 922k`; Claude strips `[1m]` before calling the provider. `N` must be an integer from 100 through 1000 (thousands of tokens). The suffix should reflect the model's supported **input** limit, not input plus output; Claude reserves additional compaction headroom below it. Garcon retains the annotated model in the chat configuration. Custom endpoints must include that exact annotated ID in their model catalog.

Existing `[1m]` names keep Claude's native compaction policy. An explicit `[Nk]` annotation overrides `CLAUDE_CODE_AUTO_COMPACT_WINDOW` for that child process only; other environment and Claude settings remain in effect. Changing or removing the numeric cap resumes the same native session in a new Claude process between turns, since the model-switch control cannot update the startup compaction flag. See [Claude's context-window documentation](https://code.claude.com/docs/en/model-config#context-window-and-auto-compaction).

## Automate And Delegate

The CLI drives ordinary visible Garcon chats through an already-running server. It covers live catalog discovery, synchronous or detached starts and resumes, steering, exact-turn waiting, status and fenced permission decisions, chat metadata, transcript search and bounded reads, export, handoff, and stop controls.

```bash
# Start detached work with explicit lineage.
bun cli/main.ts --workspace default start-async --cwd /path/to/project \
  --parent 1785337200123456 --agent codex --model gpt-5.4 \
  --permissions acceptEdits "Implement the validation and run focused tests."

# Find prior work, then read exact context around a durable transcript row.
bun cli/main.ts --workspace default search '"version bump"' --json
bun cli/main.ts --workspace default read 1785337200123456 84 -B 5 -A 5

# Inspect or steer work without creating a hidden session.
bun cli/main.ts --workspace default status 1785337200123456 --messages 20
bun cli/main.ts --workspace default resume-async 1785337200123456 \
  --allow-steer "Address the review finding and rerun the tests."
```

See the [CLI and server guide](docs/cli.md) for the full command and connection reference. `bun run build-exe` produces standalone Linux x64 and macOS arm64 executables.

The companion [cfal/garcon-skills](https://github.com/cfal/garcon-skills) package exposes the same control plane to Claude, Codex, Pi, and other skill-aware agents:

- `garcon-captain` searches, reads, organizes, monitors, and coordinates chats; `garcon-agent` starts or resumes a selected agent through the CLI.
- `garcon-task` starts, resumes, stops, or removes delegated child chats and returns their final output; `garcon-message` exchanges in-band messages with up to 16 existing chats.
- `garcon-schedule` creates future or recurring prompts for the current chat; `garcon-amp` equips a parent with fresh Oracle, Finder, Librarian, and Reporter specialists.

```bash
git clone https://github.com/cfal/garcon-skills.git
cd garcon-skills
./link.sh
```

The installer links the skills for Claude, Codex, Pi, and other compatible agents. Messages, delegated work, results, and lineage remain visible in Garcon.

## Trusted Local Use

To disable authentication for a trusted single-user environment:

```bash
bun run start --disable-auth
# or
GARCON_DISABLE_AUTH=true bun run start
```

Do not expose an unauthenticated instance to an untrusted network. Garcon does not sandbox agents or their commands. Review the [security notes](docs/security.md) before exposing it beyond a trusted network.

## Build And Develop

```bash
bun run build      # Build the SvelteKit frontend
bun run build-exe  # Build and smoke-test standalone executables
bun run check      # Lint and type-check
bun run test       # Run server, CLI, and web tests
```

- `web/`: SvelteKit and Svelte 5 frontend.
- `server/`: Bun server, chat lifecycle, providers, Git, auth, and notifications.
- `server-agents/`: agent-specific runtimes and translation behind the integration boundary.
- `common/`: shared chat, transport, agent, provider, and API contracts.
- `integration-tests/`: black-box server, provider, and browser workflows.

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow. Garcon is licensed under [GPL-3.0](LICENSE).
