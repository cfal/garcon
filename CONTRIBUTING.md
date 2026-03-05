# Contributing

Thanks for contributing to Garcon.

## Before opening a pull request

- Fork the repository and create a feature branch from `main`.
- Keep changes focused and include tests for behavior changes.
- Run local validation:
  - `bun run check`
  - `bun run test`
  - `bun run start --port 0`

## Pull request guidelines

- Describe the problem and the behavioral change clearly.
- Link related issues when applicable.
- Add screenshots for UI changes.
- Ensure CI and required checks are green before requesting merge.

## Development setup

```bash
bun run install
bun run start
```

## Code quality expectations

- Keep modules focused and avoid cross-boundary coupling.
- Prefer explicit typed contracts for API and WebSocket payloads.
- Follow established Svelte 5 runes patterns in `web/`.
