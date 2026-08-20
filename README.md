# Pi Multi-Agent

Multi-harness subagents and model-authored workflows for [Pi](https://github.com/earendil-works/pi-mono).

## Components

- `extensions/subagents` — background Pi, Claude Code, and Codex agents; persistent roles; backend-native resume.
- `extensions/workflows` — restricted workflow DSL with fan-out/fan-in orchestration and artifacts.
- `extensions/shared` — child-session safety, Hunk blackboard coordination, and shared UI/status helpers.
- `MULTI_AGENT_HANDOVER.md` — current architecture, behavior, verification commands, and next tasks.
- `BUGS.md` — confirmed defects, resolved review findings, and explicitly deferred implementation work.

## Local setup

```bash
npm install
```

Load the two entry-point directories from Pi's `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/Users/I552342/Projects/pi-multi-agent/extensions/subagents",
    "/Users/I552342/Projects/pi-multi-agent/extensions/workflows"
  ]
}
```

`extensions/shared` is imported by the entry points and is not loaded separately.

Restart Pi after changing extension files, or use `/reload` in an active TUI session.

## Verification

```bash
npm test
npm run format:check
npm run smoke
PI_OFFLINE=1 pi --list-models
```

Live backend resume tests consume model calls. Follow the gated test pattern in `MULTI_AGENT_HANDOVER.md` when changing Pi, Claude, or Codex resume behavior.

## License

MIT
