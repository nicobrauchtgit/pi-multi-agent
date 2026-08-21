import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  type SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  bindChildSessionExtensions,
  CHILD_EXCLUDED_TOOL_NAMES,
  childToolPolicy,
  createChildResources,
  filterChildExtensionPaths,
  isChildExtensionLoad,
  resolveStandaloneChildProjectTrust,
  shutdownAndDisposeChildSession,
  type DisposableChildSession,
} from "./child-session.ts";

async function withTempDir(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-child-policy-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("child denylist keeps extension and workflow structured tools available", async () => {
  await withTempDir(async (directory) => {
    let starts = 0;
    let shutdowns = 0;
    const settingsManager = SettingsManager.inMemory(undefined, {
      projectTrusted: false,
    });
    const inlineLoader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: path.join(directory, "inline-agent"),
      settingsManager,
      extensionFactories: [
        (pi) => {
          pi.on("session_start", () => {
            starts++;
          });
          pi.on("session_shutdown", () => {
            shutdowns++;
          });
          for (const name of [
            "fixture_extension_tool",
            ...CHILD_EXCLUDED_TOOL_NAMES,
          ]) {
            pi.registerTool({
              name,
              label: name,
              description: name,
              parameters: Type.Object({}),
              async execute() {
                return {
                  content: [{ type: "text", text: "ok" }],
                  details: {},
                };
              },
            });
          }
        },
      ],
    });
    await inlineLoader.reload();

    const structuredOutput = defineTool({
      name: "structured_output",
      label: "Structured Output",
      description: "fixture structured result",
      parameters: Type.Object({ value: Type.String() }),
      async execute(_id, params) {
        return {
          content: [{ type: "text", text: params.value }],
          details: {},
        };
      },
    });
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: path.join(directory, "inline-agent"),
      resourceLoader: inlineLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(directory),
      customTools: [structuredOutput],
      ...childToolPolicy(),
    });
    await bindChildSessionExtensions(session);

    assert.deepEqual(
      [...CHILD_EXCLUDED_TOOL_NAMES],
      [
        "subagent_spawn",
        "subagent_wait",
        "subagent_cancel",
        "subagent_check",
        "subagent_list",
        "subagent_followup",
        "subagent_resume",
        "subagent_roles",
        "subagent_forget",
        "workflow",
        "ask_user",
      ],
    );
    const allTools = new Set(session.getAllTools().map((tool) => tool.name));
    const activeTools = new Set(session.getActiveToolNames());
    assert.equal(starts, 1);
    assert.equal(allTools.has("fixture_extension_tool"), true);
    assert.equal(activeTools.has("fixture_extension_tool"), true);
    assert.equal(allTools.has("structured_output"), true);
    assert.equal(activeTools.has("structured_output"), true);
    for (const denied of CHILD_EXCLUDED_TOOL_NAMES) {
      assert.equal(allTools.has(denied), false, `${denied} should be denied`);
      assert.equal(
        activeTools.has(denied),
        false,
        `${denied} should be inactive`,
      );
    }
    for (const builtin of ["read", "bash", "edit", "write"]) {
      assert.equal(
        activeTools.has(builtin),
        true,
        `${builtin} should stay active`,
      );
    }

    await Promise.all([
      shutdownAndDisposeChildSession(session),
      shutdownAndDisposeChildSession(session),
    ]);
    assert.equal(shutdowns, 1);
  });
});

test("resource loading gates project extensions but retains global extensions", async () => {
  await withTempDir(async (directory) => {
    const cwd = path.join(directory, "project");
    const agentDir = path.join(directory, "agent");
    await mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
    await mkdir(path.join(agentDir, "extensions"), { recursive: true });
    const extensionSource = (name: string) => `
      export default function (pi) {
        pi.registerTool({
          name: ${JSON.stringify(name)}, label: ${JSON.stringify(name)},
          description: "fixture", parameters: { type: "object", properties: {} },
          async execute() { return { content: [{ type: "text", text: "ok" }] }; }
        });
      }
    `;
    await writeFile(
      path.join(agentDir, "extensions", "global.ts"),
      extensionSource("global_fixture"),
    );
    await writeFile(
      path.join(cwd, ".pi", "extensions", "project.ts"),
      extensionSource("project_fixture"),
    );

    const untrusted = await createChildResources({
      cwd,
      agentDir,
      projectTrusted: false,
    });
    const untrustedTools = untrusted.loader
      .getExtensions()
      .extensions.flatMap((extension) => [...extension.tools.keys()]);
    assert.equal(untrustedTools.includes("global_fixture"), true);
    assert.equal(untrustedTools.includes("project_fixture"), false);

    const trusted = await createChildResources({
      cwd,
      agentDir,
      projectTrusted: true,
    });
    const trustedTools = trusted.loader
      .getExtensions()
      .extensions.flatMap((extension) => [...extension.tools.keys()]);
    assert.equal(trustedTools.includes("global_fixture"), true);
    assert.equal(trustedTools.includes("project_fixture"), true);
  });
});

test("alternate standalone cwd only uses explicit saved trust", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const childCwd = path.join(directory, "alternate");
    const agentDir = path.join(directory, "agent");
    await mkdir(parentCwd, { recursive: true });
    await mkdir(childCwd, { recursive: true });

    assert.equal(
      resolveStandaloneChildProjectTrust({
        parentCwd,
        childCwd: parentCwd,
        parentTrusted: true,
        agentDir,
      }),
      true,
    );
    assert.equal(
      resolveStandaloneChildProjectTrust({
        parentCwd,
        childCwd,
        parentTrusted: true,
        agentDir,
      }),
      false,
    );

    new ProjectTrustStore(agentDir).set(childCwd, true);
    assert.equal(
      resolveStandaloneChildProjectTrust({
        parentCwd,
        childCwd,
        parentTrusted: false,
        agentDir,
      }),
      true,
    );
  });
});

test("shutdown helper balances hooks and disposal despite errors", async () => {
  let emits = 0;
  let disposals = 0;
  const session: DisposableChildSession = {
    extensionRunner: {
      hasHandlers: () => true,
      async emit(event: SessionShutdownEvent) {
        emits++;
        assert.deepEqual(event, { type: "session_shutdown", reason: "quit" });
        throw new Error("fixture shutdown failure");
      },
    },
    dispose() {
      disposals++;
    },
  };

  await Promise.all([
    shutdownAndDisposeChildSession(session),
    shutdownAndDisposeChildSession(session),
    shutdownAndDisposeChildSession(session),
  ]);
  assert.equal(emits, 1);
  assert.equal(disposals, 1);
});

test("child extension path filtering removes only orchestration entry points", async () => {
  await withTempDir(async (directory) => {
    const subagents = path.join(directory, "subagents");
    const workflows = path.join(directory, "workflows");
    const retained = path.join(directory, "retained");
    await Promise.all(
      [subagents, workflows, retained].map((entry) => mkdir(entry)),
    );
    assert.deepEqual(
      filterChildExtensionPaths(
        [subagents, workflows, retained, "npm:fixture-extension"],
        [subagents, workflows],
      ),
      [retained, "npm:fixture-extension"],
    );
  });
});

test("real child resource reload excludes orchestration extensions and scopes factories", async () => {
  await withTempDir(async (directory) => {
    const cwd = path.join(directory, "project");
    const agentDir = path.join(directory, "agent");
    const fixture = path.join(directory, "scope-fixture.ts");
    const sharedDirectory = path.dirname(fileURLToPath(import.meta.url));
    const childSessionModule = path.join(sharedDirectory, "child-session.ts");
    const subagents = path.resolve(sharedDirectory, "../subagents");
    const workflows = path.resolve(sharedDirectory, "../workflows");
    await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir)]);
    await writeFile(
      fixture,
      `
        import { isChildExtensionLoad } from ${JSON.stringify(childSessionModule)};
        export default function (pi) {
          const name = isChildExtensionLoad() ? "child_scope_true" : "child_scope_false";
          pi.registerTool({
            name, label: name, description: "scope probe",
            parameters: { type: "object", properties: {} },
            async execute() { return { content: [{ type: "text", text: "ok" }] }; }
          });
        }
      `,
    );
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ extensions: [subagents, workflows, fixture] }),
    );

    const { loader, settingsManager } = await createChildResources({
      cwd,
      agentDir,
      projectTrusted: false,
    });
    const loaded = loader.getExtensions().extensions;
    const toolNames = loaded.flatMap((extension) => [
      ...extension.tools.keys(),
    ]);

    assert.deepEqual(settingsManager.getExtensionPaths(), [fixture]);
    assert.equal(
      loaded.some((extension) =>
        [subagents, workflows].some((blocked) =>
          extension.resolvedPath.startsWith(blocked),
        ),
      ),
      false,
    );
    assert.deepEqual(toolNames, ["child_scope_true"]);
    assert.equal(
      toolNames.some(
        (name) => name.startsWith("subagent_") || name === "workflow",
      ),
      false,
    );

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
      ...childToolPolicy(),
    });
    await bindChildSessionExtensions(session);
    const sessionTools = new Set(
      session.getAllTools().map((tool) => tool.name),
    );
    assert.equal(sessionTools.has("child_scope_true"), true);
    assert.equal(
      [...sessionTools].some(
        (name) => name.startsWith("subagent_") || name === "workflow",
      ),
      false,
    );
    await shutdownAndDisposeChildSession(session);
  });
});

test("child extension load scope remains isolated across parallel binds", async () => {
  assert.equal(isChildExtensionLoad(), false);
  const observations: boolean[] = [];
  await Promise.all(
    [1, 2, 3].map((delay) =>
      bindChildSessionExtensions({
        async bindExtensions() {
          observations.push(isChildExtensionLoad());
          await new Promise((resolve) => setTimeout(resolve, delay));
          observations.push(isChildExtensionLoad());
        },
      }),
    ),
  );
  assert.deepEqual(observations, [true, true, true, true, true, true]);
  assert.equal(isChildExtensionLoad(), false);
});

test("shutdown helper bounds a stuck hook before disposal", async () => {
  let disposals = 0;
  const session: DisposableChildSession = {
    extensionRunner: {
      hasHandlers: () => true,
      emit: () => new Promise(() => {}),
    },
    dispose() {
      disposals++;
    },
  };

  await shutdownAndDisposeChildSession(session, { timeoutMs: 10 });
  assert.equal(disposals, 1);
});
