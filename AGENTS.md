# Repository guidance

- Read `MULTI_AGENT_HANDOVER.md` before changing the subagents/workflows stack.
- Read `docs/observability-architecture.md` before touching observability, identity/events, daemon/storage, artifacts, or web UI.
- Keep explicit workflow return values as the source of truth; Hunk is only a coordination side-channel.
- Do not introduce a second agent lifecycle vocabulary or any model-visible observability surface.
- Do not add a model-visible workflow budget API or direct agent-to-agent message bus.
- Errors remain the signal; retry clearly transient provider failures exactly once.
- Preserve trust revalidation, child orchestration deny-lists, bounded output, and shutdown cleanup.
- Verify with focused tests, `npm run smoke`, and a full `PI_OFFLINE=1 pi --list-models` startup check.
