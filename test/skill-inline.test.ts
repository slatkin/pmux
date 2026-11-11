import "./host-env.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { withInlineSkills } from "../pi-extension/pmux/launch-build.ts";
import { buildInlineSkills, findSkillFile } from "../pi-extension/pmux/skill-inline.ts";
import { tempDirHelpers } from "./temp-dir.ts";

const { withTempDir } = tempDirHelpers("pmux-skill-inline-");

function writeSkill(dir: string, name: string, body: string): string {
  mkdirSync(join(dir, name), { recursive: true });
  const path = join(dir, name, "SKILL.md");
  writeFileSync(path, `---\nname: ${name}\ndescription: test\n---\n\n${body}\n`);
  return path;
}

describe("skill inlining", () => {
  it("puts each found skill before the task in pi's expansion form", () => {
    withTempDir((root) => {
      const cwd = join(root, "repo");
      mkdirSync(join(cwd, ".git"), { recursive: true });
      const path = writeSkill(join(cwd, ".agents", "skills"), "lint", "Lint body.");
      const lookup = { cwd, agentDir: join(root, "agent"), homeDir: join(root, "home") };

      const text = withInlineSkills("THE TASK", "lint", lookup);

      assert.equal(
        text,
        [
          `<skill name="lint" location="${path}">`,
          `References are relative to ${join(cwd, ".agents", "skills", "lint")}.`,
          "",
          "Lint body.",
          "</skill>",
          "",
          "THE TASK",
        ].join("\n"),
      );
    });
  });

  it("prefers the project skill over the agent-dir skill", () => {
    withTempDir((root) => {
      const cwd = join(root, "repo");
      const project = writeSkill(join(cwd, ".pi", "skills"), "x", "project");
      writeSkill(join(root, "agent", "skills"), "x", "global");
      const lookup = { cwd, agentDir: join(root, "agent"), homeDir: join(root, "home") };

      assert.equal(findSkillFile("x", lookup), project);
    });
  });

  it("turns a skill it cannot find into a load instruction", () => {
    withTempDir((root) => {
      const lookup = { cwd: root, agentDir: join(root, "agent"), homeDir: join(root, "home") };

      assert.equal(
        buildInlineSkills("missing", lookup),
        "Before you start, read and follow these skills from your available skills: missing.",
      );
    });
  });

  it("leaves a task without skills unchanged", () => {
    withTempDir((root) => {
      assert.equal(withInlineSkills("T", undefined, { cwd: root, agentDir: root }), "T");
    });
  });
});
