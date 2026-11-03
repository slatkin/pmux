/**
 * Unit tests for the role-editor helpers in agent-defs.ts (design D4/D5):
 * the frontmatter key writer, the three-source role listing, the
 * copy-on-first-edit write and the `pi --list-models` parser. All writes
 * land in temp directories; the package's bundled roles are only read.
 */
import "./host-env.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getBundledAgentsDir,
  listModels,
  listRoles,
  parseAgentDefinition,
  parseModelList,
  setFrontmatterKey,
  writeRoleKey,
  type RoleInfo,
} from "../pi-extension/pmux/agent-defs.ts";
import { tempDirHelpers } from "./temp-dir.ts";

const { withTempDir } = tempDirHelpers("pmux-agent-defs-");

const ROLE = `---
name: worker
description: does work
model: a/x
thinking: high
---

# Worker Agent

Body text stays.
`;

describe("setFrontmatterKey", () => {
  it("replaces an existing key in place", () => {
    const next = setFrontmatterKey(ROLE, "model", "b/y");
    const lines = next.split("\n");
    assert.equal(lines[3], "model: b/y");
    // Every other line is byte-identical, body included.
    const original = ROLE.split("\n");
    for (let i = 0; i < original.length; i++) {
      if (i !== 3) assert.equal(lines[i], original[i]);
    }
  });

  it("appends an absent key as the last frontmatter line", () => {
    const next = setFrontmatterKey(ROLE, "model-fallback", "a/z");
    assert.equal(
      next,
      ROLE.replace("thinking: high\n---", "thinking: high\nmodel-fallback: a/z\n---"),
    );
  });

  it("deletes the key's line when the value is null", () => {
    const next = setFrontmatterKey(ROLE, "thinking", null);
    assert.equal(next, ROLE.replace("thinking: high\n", ""));
    assert.equal(next.includes("thinking:"), false);
  });

  it("keeps CRLF endings on the changed line and everywhere else", () => {
    const crlf = ROLE.replace(/\n/g, "\r\n");
    const next = setFrontmatterKey(crlf, "model", "b/y");
    assert.equal(next, crlf.replace("model: a/x\r\n", "model: b/y\r\n"));
    // An added key also takes the file's ending.
    const added = setFrontmatterKey(crlf, "model-fallback", "a/z");
    assert.equal(
      added,
      crlf.replace("thinking: high\r\n---", "thinking: high\r\nmodel-fallback: a/z\r\n---"),
    );
  });

  it("leaves the body bytes unchanged", () => {
    const body = "\n# Worker Agent\n\nBody text stays.\n";
    const next = setFrontmatterKey(ROLE, "model", "b/y");
    assert.ok(next.endsWith(body));
    assert.equal(next.slice(next.indexOf("---\n\n")), ROLE.slice(ROLE.indexOf("---\n\n")));
  });

  it("does not match a key that is a prefix of another", () => {
    const withFallback = ROLE.replace("model: a/x\n", "model: a/x\nmodel-fallback: a/z\n");
    const next = setFrontmatterKey(withFallback, "model", "b/y");
    assert.equal(next, withFallback.replace("model: a/x\n", "model: b/y\n"));
    const deleted = setFrontmatterKey(withFallback, "model", null);
    assert.ok(deleted.includes("model-fallback: a/z"));
    assert.equal(deleted.includes("model:"), false);
  });

  it("returns the text unchanged when deleting an absent key", () => {
    assert.equal(setFrontmatterKey(ROLE, "model-fallback", null), ROLE);
  });

  it("leaves a parseable file when deleting the only frontmatter key", () => {
    const text = "---\nmodel: a/x\n---\n\nbody\n";
    const next = setFrontmatterKey(text, "model", null);
    assert.equal(next, "---\n---\n\nbody\n");
    // An empty frontmatter block still parses, so the role stays listed.
    const parsed = parseAgentDefinition(next, "role");
    assert.ok(parsed);
    assert.equal(parsed.model, undefined);
    assert.equal(parsed.body, "body");
  });

  it("leaves a parseable CRLF file when deleting the only frontmatter key", () => {
    const text = "---\r\nmodel: a/x\r\n---\r\n\r\nbody\r\n";
    const next = setFrontmatterKey(text, "model", null);
    assert.equal(next, "---\r\n---\r\n\r\nbody\r\n");
    assert.ok(parseAgentDefinition(next, "role"));
  });

  it("rejects a file without a frontmatter block", () => {
    assert.throws(() => setFrontmatterKey("# no frontmatter\n", "model", "b/y"), /frontmatter/);
  });
});

describe("listRoles", () => {
  it("lists a user file once where it shadows a built-in role", () => {
    withTempDir((dir) => {
      const cwd = join(dir, "work");
      const agentDir = join(dir, "agent");
      mkdirSync(join(agentDir, "agents"), { recursive: true });
      writeFileSync(
        join(agentDir, "agents", "reviewer.md"),
        "---\nname: reviewer\nmodel: u/m\nthinking: low\n---\n\nuser copy\n",
      );
      const roles = listRoles(cwd, agentDir);
      const reviewer = roles.filter((role) => role.name === "reviewer");
      assert.equal(reviewer.length, 1);
      assert.equal(reviewer[0]!.source, "user");
      assert.equal(reviewer[0]!.path, join(agentDir, "agents", "reviewer.md"));
      assert.equal(reviewer[0]!.model, "u/m");
      assert.equal(reviewer[0]!.thinking, "low");
    });
  });

  it("lists a built-in-only role and creates no file", () => {
    withTempDir((dir) => {
      const cwd = join(dir, "work");
      const agentDir = join(dir, "agent");
      const roles = listRoles(cwd, agentDir);
      const tester = roles.find((role) => role.name === "visual-tester");
      assert.ok(tester);
      assert.equal(tester.source, "built-in");
      assert.equal(tester.path, join(getBundledAgentsDir(), "visual-tester.md"));
      // Listing wrote nothing anywhere.
      assert.equal(existsSync(join(agentDir, "agents")), false);
      assert.equal(existsSync(join(cwd, ".pi")), false);
    });
  });

  it("lists a project role with its values", () => {
    withTempDir((dir) => {
      const cwd = join(dir, "work");
      const agentDir = join(dir, "agent");
      mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(cwd, ".pi", "agents", "fixer.md"),
        "---\nname: fixer\nmodel: p/q\nmodel-fallback: p/r\n---\n\nbody\n",
      );
      const fixer = listRoles(cwd, agentDir).find((role) => role.name === "fixer");
      assert.ok(fixer);
      assert.equal(fixer.source, "project");
      assert.equal(fixer.model, "p/q");
      assert.equal(fixer.modelFallback, "p/r");
      assert.equal(fixer.thinking, undefined);
    });
  });

  it("skips a name no source can parse and falls through a broken winner", () => {
    withTempDir((dir) => {
      const cwd = join(dir, "work");
      const agentDir = join(dir, "agent");
      mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
      mkdirSync(join(agentDir, "agents"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "agents", "broken.md"), "no frontmatter\n");
      writeFileSync(
        join(agentDir, "agents", "broken.md"),
        "---\nname: broken\nmodel: u/b\n---\n\nbody\n",
      );
      writeFileSync(join(cwd, ".pi", "agents", "gone.md"), "still no frontmatter\n");
      const roles = listRoles(cwd, agentDir);
      // The unparseable project file falls through to the user file, which
      // wins by the same rule loadAgentDefaults uses.
      const broken = roles.find((role) => role.name === "broken");
      assert.ok(broken);
      assert.equal(broken.source, "user");
      assert.equal(broken.model, "u/b");
      // A name nothing parses is not listed at all.
      assert.equal(
        roles.find((role) => role.name === "gone"),
        undefined,
      );
    });
  });
});

describe("writeRoleKey", () => {
  it("copies a built-in role to the user agents dir on the first edit", () => {
    withTempDir((dir) => {
      const agentDir = join(dir, "agent");
      const bundled = join(getBundledAgentsDir(), "claude-code.md");
      const before = readFileSync(bundled, "utf8");
      const role: RoleInfo = {
        name: "claude-code",
        path: bundled,
        source: "built-in",
      };
      const written = writeRoleKey(role, "model", "opus-x", { agentDir });
      const copy = join(agentDir, "agents", "claude-code.md");
      assert.equal(written, copy);
      // The copy is the whole built-in file plus the one edited line.
      assert.equal(readFileSync(copy, "utf8"), setFrontmatterKey(before, "model", "opus-x"));
      // The package file is unchanged.
      assert.equal(readFileSync(bundled, "utf8"), before);
      // And the role now resolves with source `user`.
      const listed = listRoles(join(dir, "work"), agentDir).find(
        (entry) => entry.name === "claude-code",
      );
      assert.equal(listed?.source, "user");
    });
  });

  it("edits only the user copy on a second edit", () => {
    withTempDir((dir) => {
      const agentDir = join(dir, "agent");
      mkdirSync(join(agentDir, "agents"), { recursive: true });
      const copy = join(agentDir, "agents", "scout.md");
      writeFileSync(copy, "---\nname: scout\nmodel: a/x\n---\n\nuser body\n");
      const bundled = join(getBundledAgentsDir(), "scout.md");
      const bundledBefore = readFileSync(bundled, "utf8");
      const role = listRoles(join(dir, "work"), agentDir).find((entry) => entry.name === "scout")!;
      assert.equal(role.source, "user");
      const written = writeRoleKey(role, "thinking", "high", { agentDir });
      assert.equal(written, copy);
      assert.equal(
        readFileSync(copy, "utf8"),
        "---\nname: scout\nmodel: a/x\nthinking: high\n---\n\nuser body\n",
      );
      assert.equal(readFileSync(bundled, "utf8"), bundledBefore);
    });
  });

  it("keeps the role listed after deleting its only frontmatter key", () => {
    withTempDir((dir) => {
      const cwd = join(dir, "work");
      const agentDir = join(dir, "agent");
      mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
      const file = join(cwd, ".pi", "agents", "fixer.md");
      writeFileSync(file, "---\nmodel: a/x\n---\n\nbody\n");
      const role = listRoles(cwd, agentDir).find((entry) => entry.name === "fixer")!;
      writeRoleKey(role, "model", null, { agentDir });
      const after = listRoles(cwd, agentDir).find((entry) => entry.name === "fixer");
      assert.ok(after);
      assert.equal(after.model, undefined);
    });
  });

  it("edits a project file in place and writes no other file", () => {
    withTempDir((dir) => {
      const cwd = join(dir, "work");
      const agentDir = join(dir, "agent");
      mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
      const file = join(cwd, ".pi", "agents", "fixer.md");
      writeFileSync(file, "---\nname: fixer\nmodel: a/x\n---\n\nbody\n");
      const role = listRoles(cwd, agentDir).find((entry) => entry.name === "fixer")!;
      const written = writeRoleKey(role, "model", "b/y", { agentDir });
      assert.equal(written, file);
      assert.equal(readFileSync(file, "utf8"), "---\nname: fixer\nmodel: b/y\n---\n\nbody\n");
      assert.equal(existsSync(join(agentDir, "agents")), false);
    });
  });
});

describe("parseModelList", () => {
  // Captured `pi --list-models` output.
  const OUTPUT = [
    "provider       model                                               context  max-out  thinking  images",
    "claude-bridge  claude-fable-5                                      1M       128K     yes       yes   ",
    "claude-bridge  claude-haiku-4-5                                    200K     64K      yes       yes   ",
    "openrouter     deepseek/deepseek-v4.1-flash                        128K     64K      yes       no    ",
    "",
  ].join("\n");

  it("skips the header and builds provider/model pairs", () => {
    assert.deepEqual(parseModelList(OUTPUT), [
      "claude-bridge/claude-fable-5",
      "claude-bridge/claude-haiku-4-5",
      "openrouter/deepseek/deepseek-v4.1-flash",
    ]);
  });

  it("parses the no-models message to an empty list", () => {
    const empty = [
      "No models available. Use /login to log into a provider via OAuth or API key. See:",
      "  /home/user/.pi/agent/docs/providers.md",
      "  /home/user/.pi/agent/docs/models.md",
    ].join("\n");
    assert.deepEqual(parseModelList(empty), []);
  });
});

describe("listModels", () => {
  const TABLE = [
    "provider  model    context",
    "a         m-one    200K",
    "b         m-two    128K",
  ].join("\n");

  it("runs the resolved pi command with --list-models", () => {
    const calls: string[][] = [];
    const models = listModels({
      env: { PI_PMUX_PI_ENTRY: "/pkg/pi.js" },
      run: (command) => {
        calls.push(command);
        return { status: 0, stdout: TABLE, stderr: "" };
      },
    });
    assert.deepEqual(models, ["a/m-one", "b/m-two"]);
    // PI_PMUX_PI_ENTRY makes the command [node, entry, --list-models].
    assert.equal(calls[0]!.at(-1), "--list-models");
    assert.ok(calls[0]!.includes("/pkg/pi.js"));
  });

  it("reports a non-zero exit as an error carrying stderr", () => {
    assert.throws(
      () =>
        listModels({
          run: () => ({ status: 1, stdout: "", stderr: "models.json is broken" }),
        }),
      /pi --list-models failed: models\.json is broken/,
    );
  });

  it("reports a spawn failure as an error", () => {
    assert.throws(
      () =>
        listModels({
          run: () => ({ status: null, stdout: "", stderr: "", error: new Error("ENOENT") }),
        }),
      /failed to start: ENOENT/,
    );
  });

  it("reports an empty model list as an error", () => {
    assert.throws(
      () => listModels({ run: () => ({ status: 0, stdout: "provider  model\n", stderr: "" }) }),
      /listed no models/,
    );
  });
});
