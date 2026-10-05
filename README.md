# Pi Multi-Agent

Give [Pi](https://github.com/earendil-works/pi-mono) background subagents that run through Pi, Claude Code, or Codex. Pi can delegate a task, keep working, and collect the result later. It can also run multi-step workflows with parallel agents and explicit handoffs.

The extension adds no account switcher. Each harness uses its own local login and configuration. Pi still chooses the model inside the selected harness.

## Default routing

The parent agent receives this task-to-harness policy in its prompt:

| Work           | Harness          | Behavior                                     |
| -------------- | ---------------- | -------------------------------------------- |
| Planning       | Claude           | Preferred by default                         |
| Implementation | Codex            | Preferred by default                         |
| Review         | Claude and Codex | Two independent reviews, then reconciliation |

These are prompt instructions, not a hard-coded dispatcher. A user can request another harness, and the parent agent still decides which model each harness runs.

## Requirements

- Node.js 22.6 or newer and npm.
- A working Pi installation.
- Claude Code and Codex authentication for the default routes. Keep `claude` and `codex` on `PATH` so the extension can reuse their installed configuration. The Claude SDK has a bundled fallback, but an installed CLI keeps its version and login aligned with your terminal.
- Codex 0.147.0 or newer when using structured outputs.

Hunk is optional. When it is installed, agents can use its shared blackboard for comments tied to the current diff.

## Let an agent install it

Send this prompt to an agent that can edit your Pi configuration:

```text
Install https://github.com/nicobrauchtgit/pi-multi-agent for my Pi setup.

1. Check that Node.js is at least 22.6 and that `pi` is available.
2. Clone the repository into a stable directory and run `npm install`.
3. Preserve my existing ~/.pi/agent/settings.json. Add the absolute paths to
   extensions/subagents and extensions/workflows to its `extensions` array.
   Do not add extensions/shared and do not remove my other settings or extensions.
4. Check whether `claude` and `codex` are available and authenticated. Report a
   missing harness instead of changing unrelated authentication settings.
5. Run `npm run check`, `npm test`, `npm run format:check`, and `npm run smoke`.
6. Tell me to restart Pi or run /reload.
```

## Manual setup

Clone the repository and install its dependencies:

```bash
git clone https://github.com/nicobrauchtgit/pi-multi-agent.git
cd pi-multi-agent
npm install
```

Get the absolute path to the clone with `pwd`. Add the following two directories to the existing `extensions` array in `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/absolute/path/to/pi-multi-agent/extensions/subagents",
    "/absolute/path/to/pi-multi-agent/extensions/workflows"
  ]
}
```

Keep any existing settings and extension entries. Do not add `extensions/shared`; both entry points import it themselves.

Restart Pi, or run `/reload` in the Pi TUI. Confirm that both extensions load:

```bash
npm run smoke
```

## Using it

Ask Pi to delegate when you want subagents involved. For example:

```text
Plan this migration with a planning subagent, implement it, then run the default adversarial review.
```

The model receives tools for spawning, checking, continuing, resuming, waiting for, and cancelling subagents. Named roles persist their native session information across Pi restarts.

Pi also adds these TUI commands:

- `/subagents` opens the subagent list and transcripts.
- `/workflows` opens workflow progress and saved results.
- `/btw` runs a one-off side question while the main agent keeps working.

The workflow tool only runs when you explicitly request a workflow or say `ultracode`. Workflows can fan tasks out, pass structured results between stages, and combine the final result.

## Customize the routing

Edit [`extensions/shared/harness-routing.ts`](extensions/shared/harness-routing.ts):

```ts
export const TASK_HARNESS_MAP = Object.freeze({
  planning: Object.freeze(["claude"]),
  implementation: Object.freeze(["codex"]),
  review: Object.freeze(["claude", "codex"]),
});
```

Valid harness names are `pi`, `claude`, and `codex`. Each entry in `review` creates one independent reviewer in the injected policy. For example, `review: ["pi", "claude"]` asks for one Pi review and one Claude review.

The map selects harnesses only. Model selection stays separate:

- Pi inherits the parent model unless the agent supplies a Pi model ID.
- Claude uses its harness default unless the agent supplies a Claude model alias.
- Codex uses its harness default unless the agent supplies a Codex model slug.

There is no built-in work-versus-personal model switch. To use another account or provider setup, change that harness's local configuration. Reload Pi after editing the map.

## Safety and local data

Subagents are autonomous and receive the normal permissions of their selected harness. Only run them in directories you trust. Child agents cannot recursively start more agents or ask the user. The shared manager allows at most four running agents.

Persistent role records and workflow results stay on the local machine:

```text
~/.pi/agent/multi-agent/roles/
~/.pi/agent/workflows/
```

## Development checks

```bash
npm run check
npm test
npm run format:check
npm run smoke
PI_OFFLINE=1 pi --list-models
```

The live backend tests consume model calls. See [`MULTI_AGENT_HANDOVER.md`](MULTI_AGENT_HANDOVER.md) before changing backend resume behavior or the shared workflow runtime.

## License

MIT
