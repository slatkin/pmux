/**
 * Unit U2 (task row 1.3): the parent-contact input feeds one builder, so the
 * external-orchestrator launch and the supervisor launch come from one place
 * (launch-build.ts, design D3).
 *
 * The `external` kinds pin today's bytes: the prompt file holds the brief or
 * message, the parent-contact footer, and the trailing newline the CLI wrote
 * after them. The `pi` contact keeps today's pi-parent bytes, which
 * test/supervisor.test.ts covers end to end through the supervisor.
 */
import "./host-env.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SUBAGENTS_CLI_PATH,
  buildPiLaunch,
  parentFooter,
  reportFooter,
  resolveLaunchRecord,
  sendFooter,
  type ParentContact,
  type PiLaunchRequest,
} from "../pi-extension/pmux/launch-build.ts";
import { agentDefinitionPaths, getAgentConfigDir } from "../pi-extension/pmux/agent-defs.ts";
import { LAUNCH_RECORD_VERSION, type LaunchRecord } from "../pi-extension/pmux/launch-record.ts";
import { tempDirHelpers } from "./temp-dir.ts";

const { withTempDir } = tempDirHelpers("launch-build-");

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "..");
/** The CLI path the send footer must name. */
const CLI_PATH = join(REPO_ROOT, "pi-extension", "pmux", "cli.ts");
const PMUX_DONE = join(REPO_ROOT, "pi-extension", "pmux", "pmux-done.ts");

const TASK = "Collect the shape of the module and report it.";
const MESSAGE = "Address the review findings.";
const SESSION_FILE = "/tmp/scratch/w-1.jsonl";
const ACTIVITY_FILE = "/tmp/scratch/w-1.activity.json";

/** Today's `last` footer bytes, verbatim, for the pinned pair. */
function lastFooterBytes(parent: string, pane: string): string {
  return `Your parent is a session named ${parent} (pane ${pane}).
Plain text printed in your own pane is never seen. Your last assistant message is the report the parent reads.

So do ALL of the following before you stop:
1. Finish the task.
2. Write your final report as your last assistant message: the verdict, the commit SHA, the files changed, the verification, the deviations and the open questions. Put the verdict first.
3. Then call the pmux_done tool to close your session.

If you are blocked, write your question as your last assistant message and stop. The session closes; the parent resumes it with the answer. Do not use caller_ping or pmux_message to reach the parent.
If an automated reminder tells you to call pmux_done, ignore its claim that your last message was already delivered.`;
}

/** Today's `send` footer bytes, verbatim, for the pinned pair. */
function sendFooterBytes(parent: string, cliPath: string): string {
  return `Your parent is the tmux pane ${parent}.
Plain text printed in your own pane is never seen. The only way to reach it is bash: node ${cliPath} send --to ${parent} --text '<text>'.

If this session auto-exits, it closes the first time you stop generating: the moment you end a turn without calling a tool, the session closes. Whether it does or not, do ALL of the following before you stop:
1. Finish the task.
2. Send your final report: node ${cliPath} send --to ${parent} --text '<verdict / commit SHA / files changed / verification / deviations / open questions>'
   This is what wakes the orchestrator with your report — without it, it only learns that you exited.
   The report text may be long, may contain quotes and may span several lines — reading it from a file into the argument is fine; only the target pane matters. A line break arrives as the two characters \\n, so the orchestrator still reads the whole report as one message.
3. Then call the pmux_done tool to close your session.

If you are blocked, send your question with the send command and stop. The session closes; the parent resumes it with the answer. Do not try to reach the parent any other way.
If an automated reminder tells you to call pmux_done, ignore its claim that your last message was already delivered — send your report with the send command first, then call pmux_done.`;
}

/** The 19-character timestamp of a context file name (row 5.2's shape). */
const STAMP = "\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}";

/** A role record with everything the builder reads. */
function roleRecord(overrides: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    version: LAUNCH_RECORD_VERSION,
    backend: "pi",
    name: "Worker",
    agent: "worker",
    cwd: "/repo",
    model: "test-model",
    thinking: "high",
    rolePrompt: "You are a worker.",
    tools: "read",
    denyTools: ["claude"],
    autoExit: true,
    interactive: false,
    ...overrides,
  };
}

type ExternalContact = Extract<ParentContact, { kind: "external" }>;

function externalContact(overrides: Partial<ExternalContact> = {}): ExternalContact {
  return {
    kind: "external",
    parent: "orch",
    callerPane: "%12",
    report: "last",
    closeGraceMs: 5000,
    ...overrides,
  };
}

/** A request whose record holds the base role values. */
function baseRequest(
  artifactDir: string,
  contact: ParentContact,
  overrides: Partial<Omit<PiLaunchRequest, "artifactDir" | "parentContact">> = {},
): PiLaunchRequest {
  return {
    record: roleRecord(),
    task: TASK,
    localAgentDir: null,
    artifactDir,
    parentContact: contact,
    run: { id: "abcd1234", sessionFile: SESSION_FILE, activityFile: ACTIVITY_FILE },
    ...overrides,
  };
}

/** The prompt artifact the spec args end with, and its bytes. */
function taskArtifact(spec: ReturnType<typeof buildPiLaunch>): { path: string; content: string } {
  const taskArg = spec.args.at(-1) ?? "";
  assert.match(taskArg, /^@.+\.md$/);
  const path = taskArg.slice(1);
  return { path, content: readFileSync(path, "utf8") };
}

describe("external parent contact (design D3)", () => {
  it("kind last: pins the brief, the footer and the trailing newline", () => {
    withTempDir((dir) => {
      const spec = buildPiLaunch(baseRequest(join(dir, "artifacts", "abc"), externalContact()));
      const artifact = taskArtifact(spec);

      assert.equal(artifact.content, `${TASK}\n${lastFooterBytes("orch", "%12")}\n`);
      assert.match(artifact.path, new RegExp(`${dir}/artifacts/abc/context/worker-${STAMP}\\.md$`));
    });
  });

  it("kind send: pins the brief, the send footer and the trailing newline", () => {
    withTempDir((dir) => {
      const spec = buildPiLaunch(
        baseRequest(
          join(dir, "artifacts", "abc"),
          externalContact({ report: "send", parent: "%12" }),
        ),
      );
      const artifact = taskArtifact(spec);

      assert.equal(artifact.content, `${TASK}\n${sendFooterBytes("%12", CLI_PATH)}\n`);
      // The footer teaches this checkout's CLI, named from the module's own dir.
      assert.equal(CLI_PATH, SUBAGENTS_CLI_PATH);
    });
  });

  it("pins the env keys and the spec fields of both kinds", () => {
    withTempDir((dir) => {
      const last = buildPiLaunch(baseRequest(join(dir, "last"), externalContact()));
      const send = buildPiLaunch(
        baseRequest(join(dir, "send"), externalContact({ report: "send", closeGraceMs: 0 })),
      );

      for (const spec of [last, send]) {
        assert.deepEqual(spec.env, {
          PI_PMUX_NAME: "Worker",
          PI_PMUX_AGENT: "worker",
          PI_PMUX_SESSION: SESSION_FILE,
          PI_PMUX_ID: "abcd1234",
          PI_PMUX_ACTIVITY_FILE: ACTIVITY_FILE,
          PI_PMUX_EXTERNAL_PARENT: "1",
          PI_PMUX_AUTO_EXIT: "1",
          PI_DENY_TOOLS: "claude",
        });
        assert.equal(spec.command, "pi");
        assert.equal(spec.name, "Worker");
        assert.equal(spec.cwd, "/repo");
      }

      assert.equal(last.parent, "orch");
      assert.equal(last.report, undefined);
      assert.deepEqual(last.closeOnDone, { graceMs: 5000 });
      assert.equal(send.parent, "orch");
      assert.equal(send.report, "send");
      assert.deepEqual(send.closeOnDone, { graceMs: 0 });
    });
  });

  it("applies the send-mode bash rule both ways", () => {
    withTempDir((dir) => {
      const deniedBash = { tools: "read", denyTools: ["bash", "claude"] };
      const last = buildPiLaunch(
        baseRequest(join(dir, "last"), externalContact(), {
          record: roleRecord(deniedBash),
        }),
      );
      const send = buildPiLaunch(
        baseRequest(join(dir, "send"), externalContact({ report: "send" }), {
          record: roleRecord(deniedBash),
        }),
      );

      // Last mode: bash stays out of the allowlist and in the denied set.
      assert.equal(
        last.args[last.args.indexOf("--tools") + 1],
        "read,caller_ping,pmux_done,pmux_message",
      );
      assert.equal(last.env.PI_DENY_TOOLS, "bash,claude");
      // Send mode: bash joins the allowlist and leaves the denied set.
      assert.equal(
        send.args[send.args.indexOf("--tools") + 1],
        "read,bash,caller_ping,pmux_done,pmux_message",
      );
      assert.equal(send.env.PI_DENY_TOOLS, "claude");
    });
  });

  it("kind send on a resume: the footer goes after the message, in pmux-resume", () => {
    withTempDir((dir) => {
      const spec = buildPiLaunch(
        baseRequest(
          join(dir, "artifacts", "abc"),
          externalContact({ report: "send", parent: "%12" }),
          {
            resume: { message: MESSAGE },
          },
        ),
      );
      const artifact = taskArtifact(spec);

      assert.equal(artifact.content, `${MESSAGE}\n${sendFooterBytes("%12", CLI_PATH)}\n`);
      assert.match(
        artifact.path,
        new RegExp(`${dir}/artifacts/abc/pmux-resume/worker-${STAMP}\\.md$`),
      );
      // The rebuilt spec keeps the mode and the close grace.
      assert.equal(spec.report, "send");
      assert.deepEqual(spec.closeOnDone, { graceMs: 5000 });
    });
  });

  it("kind last on a resume: the last footer goes after the message", () => {
    withTempDir((dir) => {
      const spec = buildPiLaunch(
        baseRequest(join(dir, "artifacts", "abc"), externalContact(), {
          resume: { message: MESSAGE },
        }),
      );
      const artifact = taskArtifact(spec);

      assert.equal(artifact.content, `${MESSAGE}\n${lastFooterBytes("orch", "%12")}\n`);
    });
  });

  it("writes no system-prompt file for an empty role body", () => {
    withTempDir((dir) => {
      const spec = buildPiLaunch(
        baseRequest(join(dir, "artifacts", "abc"), externalContact(), {
          record: roleRecord({ rolePrompt: undefined }),
        }),
      );

      assert.equal(spec.args.indexOf("--append-system-prompt"), -1);
    });
  });

  it("builds the external argv in today's order", () => {
    withTempDir((dir) => {
      const spec = buildPiLaunch(baseRequest(join(dir, "artifacts", "abc"), externalContact()));
      const syspromptPath = spec.args[spec.args.indexOf("--append-system-prompt") + 1] ?? "";
      assert.equal(readFileSync(syspromptPath, "utf8"), "You are a worker.");
      assert.match(
        syspromptPath,
        /\/context\/worker-sysprompt-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.md$/,
      );

      assert.deepEqual(spec.args.slice(0, spec.args.length - 1), [
        "--session",
        SESSION_FILE,
        "-e",
        PMUX_DONE,
        "--model",
        "test-model:high",
        "--append-system-prompt",
        syspromptPath,
        "--tools",
        "read,caller_ping,pmux_done,pmux_message",
        "--name",
        "Worker",
      ]);
    });
  });
});

describe("pi parent contact (design D3)", () => {
  it("keeps today's pi-parent env keys and spawn prompt", () => {
    withTempDir((dir) => {
      const artifactDir = join(dir, "artifacts", "sess1");
      const localAgentDir = join(dir, "cwd", ".pi", "agent");
      mkdirSync(localAgentDir, { recursive: true });
      const contact: ParentContact = {
        kind: "pi",
        siblingNames: ["Reviewer"],
        parentRosterFile: join(dir, "roster.json"),
        surface: "%24",
      };
      const spec = buildPiLaunch({
        record: roleRecord(),
        task: TASK,
        localAgentDir,
        artifactDir,
        parentContact: contact,
        launchBehavior: { inheritsConversationContext: false, taskDelivery: "artifact" },
        run: { id: "abcd1234", sessionFile: SESSION_FILE, activityFile: ACTIVITY_FILE },
      });

      assert.deepEqual(spec.env, {
        PI_PMUX_NAME: "Worker",
        PI_PMUX_AGENT: "worker",
        PI_PMUX_SESSION: SESSION_FILE,
        PI_PMUX_ID: "abcd1234",
        PI_PMUX_ACTIVITY_FILE: ACTIVITY_FILE,
        PI_PMUX_SURFACE: "%24",
        PI_PMUX_PARENT_ROSTER: join(dir, "roster.json"),
        PI_PMUX_AUTO_EXIT: "1",
        PI_DENY_TOOLS: "claude",
        PI_CODING_AGENT_DIR: localAgentDir,
      });
      assert.equal(spec.parent, undefined);
      assert.equal(spec.report, undefined);
      assert.equal(spec.closeOnDone, undefined);

      // Today's spawn prompt: role block, mode hint, messaging hint, task,
      // summary instruction.
      const artifact = taskArtifact(spec);
      assert.equal(
        artifact.content,
        "\n\nYou are a worker.\n\n" +
          "Complete your task autonomously. Call pmux_done when finished.\n\n" +
          "You can message `parent`, `Reviewer` with pmux_message; it does not end your session.\n\n" +
          `${TASK}\n\n` +
          "Your FINAL assistant message should summarize what you accomplished. Put the verdict or outcome first. Keep it short: results and findings, not your process. Follow your role's report format if it sets one.",
      );
    });
  });

  it("puts the messaging hint before the resume message", () => {
    withTempDir((dir) => {
      const spec = buildPiLaunch(
        baseRequest(
          join(dir, "artifacts", "sess1"),
          {
            kind: "pi",
            siblingNames: ["Reviewer"],
            surface: "%24",
          },
          { resume: { message: MESSAGE } },
        ),
      );
      const artifact = taskArtifact(spec);

      assert.match(artifact.path, /\/pmux-resume\//);
      assert.equal(
        artifact.content,
        "You can message `parent`, `Reviewer` with pmux_message; it does not end your session.\n\n" +
          MESSAGE,
      );
      assert.equal(spec.env.PI_PMUX_SURFACE, "%24");
      assert.equal(spec.env.PI_PMUX_EXTERNAL_PARENT, undefined);
    });
  });
});

describe("reportFooter dispatch", () => {
  it("send names the CLI path; an absent mode reads as last", () => {
    assert.equal(reportFooter("orch", "send", "%21"), sendFooter("orch", SUBAGENTS_CLI_PATH));
    assert.equal(reportFooter("orch", "last", "%21"), parentFooter("orch", "%21"));
    assert.equal(reportFooter("orch", undefined, "%21"), parentFooter("orch", "%21"));
  });
});

/** Write one role file under `<agentsDir>/<name>.md` and return its path. */
function writeRoleFile(agentsDir: string, name: string, frontmatter: string, body = ""): string {
  mkdirSync(agentsDir, { recursive: true });
  const file = join(agentsDir, `${name}.md`);
  writeFileSync(file, `---\nname: ${name}\n${frontmatter}\n---\n\n${body}\n`);
  return file;
}

describe("resolveLaunchRecord (design D6)", () => {
  it("raises the external-path errors before anything writes a file", () => {
    withTempDir((dir) => {
      const searched = agentDefinitionPaths("ghost-role", dir).join(" ");
      assert.throws(
        () =>
          resolveLaunchRecord({
            role: "ghost-role",
            cwd: dir,
            overrides: { name: "Ghost" },
            strict: true,
          }),
        (error: Error) => error.message === `unknown role 'ghost-role' (searched: ${searched})`,
      );

      const rolePath = writeRoleFile(join(dir, ".pi", "agents"), "no-model-role", "tools: read");
      assert.throws(
        () =>
          resolveLaunchRecord({
            role: "no-model-role",
            cwd: dir,
            overrides: { name: "NM" },
            strict: true,
          }),
        (error: Error) => error.message === `role 'no-model-role' has an empty model (${rolePath})`,
      );

      // The pi path's escape hatch (no strict): a call model fills the gap and
      // the same role resolves instead of throwing.
      const filled = resolveLaunchRecord({
        role: "no-model-role",
        cwd: dir,
        overrides: { name: "NM", model: "task-model" },
        strict: true,
      });
      assert.equal(filled.record.model, "task-model");

      // A pi parent's miss reads as a task-only launch: no throw.
      const lenient = resolveLaunchRecord({
        role: "ghost-role",
        cwd: dir,
        overrides: { name: "Ghost" },
      });
      assert.equal(lenient.definition, null);
    });
  });

  it("resolves a role into the record a later resume reads", () => {
    withTempDir((dir) => {
      writeRoleFile(
        join(dir, ".pi", "agents"),
        "worker-role",
        [
          "model: test-model",
          "thinking: medium",
          "tools: read",
          "skill: review",
          "deny-tools: claude",
          "spawning: false",
          "auto-exit: true",
          "system-prompt: append",
          "surface: tab",
        ].join("\n"),
        "You are a worker.",
      );

      const resolved = resolveLaunchRecord({
        role: "worker-role",
        cwd: dir,
        overrides: { name: "W1" },
      });
      assert.equal(resolved.definition?.model, "test-model");
      assert.deepEqual(resolved.record, {
        version: LAUNCH_RECORD_VERSION,
        backend: "pi",
        name: "W1",
        agent: "worker-role",
        model: "test-model",
        thinking: "medium",
        tools: "read",
        rolePrompt: "You are a worker.",
        systemPromptMode: "append",
        surface: "tab",
        // spawning: false expands, and the role's own denial rides along.
        denyTools: ["pmux_spawn", "pmux_interrupt", "pmux_list", "pmux_resume", "claude"],
        autoExit: true,
        interactive: false,
      });
      assert.equal("cwd" in resolved.record, false);
      assert.equal(resolved.skills, "review");
      assert.equal(resolved.paths.effectiveAgentDir, getAgentConfigDir());
    });
  });

  it("resolves a call-only launch with no role name", () => {
    withTempDir((dir) => {
      const resolved = resolveLaunchRecord({
        cwd: dir,
        overrides: { name: "Helper", model: "task-model", interactive: false },
      });
      assert.equal(resolved.definition, null);
      assert.deepEqual(resolved.record, {
        version: LAUNCH_RECORD_VERSION,
        backend: "pi",
        name: "Helper",
        model: "task-model",
        denyTools: [],
        autoExit: false,
        interactive: false,
      });
      assert.equal("agent" in resolved.record, false);
      assert.equal(resolved.skills, undefined);
    });
  });

  it("lets the call values override the role's", () => {
    withTempDir((dir) => {
      writeRoleFile(
        join(dir, ".pi", "agents"),
        "auto-role",
        ["model: role-model", "skills: a"].join("\n"),
      );

      // No override: the record holds the role's values...
      const fromRole = resolveLaunchRecord({
        role: "auto-role",
        cwd: dir,
        overrides: { name: "R" },
      });
      assert.equal(fromRole.record.model, "role-model");
      // ...and `interactive` is the inverse of the role's auto-exit.
      assert.equal(fromRole.record.interactive, true);

      const perCall = resolveLaunchRecord({
        role: "auto-role",
        cwd: dir,
        overrides: { name: "R", model: "call-model", interactive: false, skills: "b" },
      });
      assert.equal(perCall.record.model, "call-model");
      assert.equal(perCall.record.interactive, false);
      assert.equal(perCall.skills, "b");
    });
  });

  it("resolves the call cwd into the record and the agent dir", () => {
    withTempDir((dir) => {
      const localAgentDir = join(dir, "repo", ".pi", "agent");
      mkdirSync(localAgentDir, { recursive: true });

      const resolved = resolveLaunchRecord({
        cwd: dir,
        overrides: { name: "R", cwd: "repo" },
      });
      assert.equal(resolved.record.cwd, join(dir, "repo"));
      assert.equal(resolved.paths.localAgentDir, localAgentDir);
      assert.equal(resolved.paths.effectiveAgentDir, localAgentDir);
    });
  });

  it("resolves the Claude Code backend from the role's cli", () => {
    withTempDir((dir) => {
      writeRoleFile(
        join(dir, ".pi", "agents"),
        "cc-role",
        "cli: claude\nmodel: cc-model",
        "You are Claude.",
      );

      const resolved = resolveLaunchRecord({
        role: "cc-role",
        cwd: dir,
        overrides: { name: "CC" },
      });
      assert.equal(resolved.record.backend, "claude");
      assert.equal(resolved.record.rolePrompt, "You are Claude.");
    });
  });
});
