import "./host-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  decodeChildEnv,
  encodeChildEnv,
  isSubagentChild,
  subagentMarkerEnv,
  type ChildEnv,
} from "../pi-extension/pmux/child-env.ts";
import { buildSpawnEnvParts, resolveDenyTools } from "../pi-extension/pmux/supervisor.ts";
import subagentsExtension from "../pi-extension/pmux/index.ts";
import subagentDoneExtension from "../pi-extension/pmux/pmux-done.ts";

test("round-trips a full ChildEnv", () => {
  const full: ChildEnv = {
    name: "child",
    agent: "scout",
    sessionFile: "/tmp/s.jsonl",
    id: "id-1",
    activityFile: "/tmp/a.json",
    surface: "surface-1",
    parentRosterFile: "/tmp/r.json",
    externalParent: false,
    autoExit: true,
    denyTools: ["pmux_spawn", "claude"],
  };
  assert.deepEqual(decodeChildEnv(encodeChildEnv(full)), full);
});

test("round-trips a minimal ChildEnv", () => {
  const minimal: ChildEnv = { autoExit: false, denyTools: [] };
  const decoded = decodeChildEnv(encodeChildEnv(minimal));
  assert.equal(decoded.autoExit, false);
  assert.equal(decoded.externalParent, false);
  assert.deepEqual(decoded.denyTools, []);
  assert.equal(decoded.name, undefined);
  assert.equal(decoded.sessionFile, undefined);
});

test("round-trips the external-parent marker", () => {
  const marked: ChildEnv = { externalParent: true, autoExit: false, denyTools: [] };
  const encoded = encodeChildEnv(marked);
  assert.equal(encoded.PI_PMUX_EXTERNAL_PARENT, "1");
  assert.equal(decodeChildEnv(encoded).externalParent, true);
});

test("encodeChildEnv leaves out an empty deny list and autoExit false", () => {
  assert.deepEqual(encodeChildEnv({ autoExit: false, denyTools: [] }), {});
});

test("decodeChildEnv trims and drops empty deny entries", () => {
  const env = decodeChildEnv({ PI_DENY_TOOLS: " pmux_spawn, ,claude ," });
  assert.deepEqual(env.denyTools, ["pmux_spawn", "claude"]);
});

test("decodeChildEnv treats an empty string as not set", () => {
  const env = decodeChildEnv({
    PI_PMUX_NAME: "",
    PI_PMUX_SESSION: "",
    PI_PMUX_AUTO_EXIT: "",
    PI_DENY_TOOLS: "",
  });
  assert.equal(env.name, undefined);
  assert.equal(env.sessionFile, undefined);
  assert.equal(env.autoExit, false);
  assert.deepEqual(env.denyTools, []);
});

test("isSubagentChild is true only when PI_PMUX_SESSION is set", () => {
  assert.equal(isSubagentChild({ PI_PMUX_SESSION: "/tmp/s.jsonl" }), true);
  assert.equal(isSubagentChild({ PI_PMUX_SESSION: "" }), false);
  assert.equal(isSubagentChild({ PI_PMUX_NAME: "child" }), false);
  assert.equal(isSubagentChild({}), false);
});

test("subagentMarkerEnv gives a root parent's child depth 1 and the marker", () => {
  assert.deepEqual(subagentMarkerEnv({}), {
    PI_SUBAGENT_DEPTH: "1",
    PI_BLACKHOLE_SUBAGENT_MARKERS: "PI_PMUX_SESSION",
  });
});

test("subagentMarkerEnv increments an inherited depth", () => {
  assert.equal(subagentMarkerEnv({ PI_SUBAGENT_DEPTH: "2" }).PI_SUBAGENT_DEPTH, "3");
});

test("subagentMarkerEnv treats a non-positive or malformed depth as a root", () => {
  for (const raw of ["0", "-2", "abc", ""]) {
    assert.equal(
      subagentMarkerEnv({ PI_SUBAGENT_DEPTH: raw }).PI_SUBAGENT_DEPTH,
      "1",
      `depth ${JSON.stringify(raw)}`,
    );
  }
});

test("subagentMarkerEnv appends to the inherited marker list without duplicating", () => {
  const merged = subagentMarkerEnv({
    PI_BLACKHOLE_SUBAGENT_MARKERS: "FOO, BAR",
  });
  assert.equal(merged.PI_BLACKHOLE_SUBAGENT_MARKERS, "FOO,BAR,PI_PMUX_SESSION");
  const already = subagentMarkerEnv({
    PI_BLACKHOLE_SUBAGENT_MARKERS: "FOO,PI_PMUX_SESSION",
  });
  assert.equal(already.PI_BLACKHOLE_SUBAGENT_MARKERS, "FOO,PI_PMUX_SESSION");
});

test("buildSpawnEnvParts marks the child env for subagent detectors", () => {
  const spawn = buildSpawnEnvParts({
    name: "scout",
    subagentSessionFile: "/tmp/s.jsonl",
    id: "id-1",
    activityFile: "/tmp/a.json",
    denySet: new Set(),
    parentEnv: { PI_SUBAGENT_DEPTH: "1" },
  });
  assert.equal(spawn.PI_SUBAGENT_DEPTH, "2");
  assert.equal(spawn.PI_BLACKHOLE_SUBAGENT_MARKERS, "PI_PMUX_SESSION");
});

/** Just enough of the extension API for `index.ts` and `pmux-done.ts`. */
function makeMockPi() {
  const registeredTools: Array<any> = [];
  return {
    registeredTools,
    api: {
      on() {},
      events: { on() {} },
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand() {},
      registerMessageRenderer() {},
      registerShortcut() {},
      sendMessage() {},
      sendUserMessage() {},
      getAllTools() {
        return [];
      },
    } as any,
  };
}

test("a spawned child env registers as a child with spawning tools denied", async () => {
  const dir = mkdtempSync(join(tmpdir(), "child-env-pair-"));
  const sessionFile = join(dir, "child.jsonl");
  const denied = resolveDenyTools({ spawning: false });
  const spawnEnv = buildSpawnEnvParts({
    name: "scout",
    agent: "scout",
    autoExit: true,
    subagentSessionFile: sessionFile,
    id: "id-1",
    activityFile: join(dir, "activity.json"),
    surface: "surface-1",
    codingAgentDir: dir,
    denySet: denied,
    parentRosterFile: join(dir, "roster.json"),
  });
  const testEnv: Record<string, string> = {
    ...spawnEnv,
    TMUX: "/tmp/tmux-0/default",
    TMUX_PANE: "%7",
  };
  const saved = new Map(Object.keys(testEnv).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(testEnv)) process.env[key] = value;

  const { api, registeredTools } = makeMockPi();
  try {
    subagentDoneExtension(api);
    subagentsExtension(api);

    assert.equal(isSubagentChild(process.env), true);

    const deniedNames = [...denied].sort();
    assert.deepEqual(decodeChildEnv(process.env).denyTools.sort(), deniedNames);

    const toolNames = registeredTools.map((tool) => tool.name);
    for (const name of deniedNames) assert.equal(toolNames.includes(name), false, name);

    const messageTool = registeredTools.find((tool) => tool.name === "pmux_message");
    assert.ok(messageTool, "expected pmux_message to be registered");
    const result = await messageTool.execute("call-1", { to: "parent", message: "hello" });
    assert.equal(result.details?.relation, "parent");
    const written = readFileSync(`${sessionFile}.msg`, "utf8").trim();
    assert.match(written, /hello/);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
