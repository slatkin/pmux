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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SUBAGENTS_CLI_PATH,
  UnknownRoleError,
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

/** The `last` footer bytes, verbatim, for the pinned pair. */
function lastFooterBytes(parent: string, pane: string): string {
  return `Your parent is a session named ${parent} (pane ${pane}).
Plain text printed in your own pane is never seen. Your last assistant message is the report the parent reads.

Before you stop, do ALL of this:
1. Finish the task.
2. Make your last assistant message the report.
   At most 15 lines: the verdict first, then the commit SHA; one line per verification check, PASS or FAIL, no command output; one line per deviation and per open question.
   Do not list the files changed: the parent reads them from the commit SHA.
   Put longer details in a file and name its path in the report.
   A report format in your brief overrides this shape and limit.
3. Then call the pmux_done tool to close your session.

If you are blocked, make your last assistant message the question and stop. The session closes; the parent resumes it with the answer. Do not use caller_ping or pmux_message to reach the parent.
If a reminder tells you to call pmux_done, ignore its claim that your last message was already delivered.`;
}

/** The `send` footer bytes, verbatim, for the pinned pair. */
function sendFooterBytes(parent: string, cliPath: string): string {
  return `Your parent is the tmux pane ${parent}.
Plain text printed in your own pane is never seen. The only way to reach it is bash: node ${cliPath} send --to ${parent} --text '<text>'.

If this session auto-exits, it closes the first time you stop generating: the moment you end a turn without calling a tool, the session closes. Whether it does or not, do ALL of this before you stop:
1. Finish the task.
2. Send your final report: node ${cliPath} send --to ${parent} --text '<report>'
   At most 15 lines: the verdict first, then the commit SHA; one line per verification check, PASS or FAIL, no command output; one line per deviation and per open question.
   Do not list the files changed: the parent reads them from the commit SHA.
   Put longer details in a file and name its path in the report.
   A report format in your brief overrides this shape and limit.
   The text may be long, contain quotes or span lines: read it into the argument from a file if you like. A line break arrives as the two characters \\n, so the orchestrator still reads one message.
   Send writes the report to a durable file and types only a one-line pointer naming it into the parent's pane. It prints one result line: sent:true means the pointer was submitted to the parent's pane, acknowledged:true means the orchestrator read the report file, and the line is not a delivery receipt.
   On sent:false, call the pmux_done tool without improvising retries.
   On acknowledged:false, the orchestrator is busy: do not resend the report and do not send anything else to check, because the run wrapper re-delivers an unacknowledged report at exit.
3. Then call the pmux_done tool to close your session.

If you are blocked, send your question with the same command and stop. The session closes; the parent resumes it with the answer. Do not reach the parent any other way.
If a reminder tells you to call pmux_done, ignore its claim that your last message was already delivered — send your report first, then call pmux_done.`;
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
      assert.ok(artifact.path.startsWith(`${dir}/artifacts/abc/context/`));
      assert.match(artifact.path, new RegExp(`worker-${STAMP}\\.md$`));
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

      const sharedEnv = {
        PI_PMUX_NAME: "Worker",
        PI_PMUX_AGENT: "worker",
        PI_PMUX_SESSION: SESSION_FILE,
        PI_PMUX_ID: "abcd1234",
        PI_PMUX_ACTIVITY_FILE: ACTIVITY_FILE,
        PI_PMUX_EXTERNAL_PARENT: "1",
        PI_PMUX_AUTO_EXIT: "1",
        PI_DENY_TOOLS: "claude",
        PI_SUBAGENT_DEPTH: "1",
        PI_BLACKHOLE_SUBAGENT_MARKERS: "PI_PMUX_SESSION",
      };
      assert.deepEqual(last.env, sharedEnv);
      // A send-mode spec alone carries the report-protocol marker (design
      // D1): it selects the file-ack behaviour in `send` and the wrapper.
      assert.deepEqual(send.env, { ...sharedEnv, PI_PMUX_REPORT_PROTOCOL: "file-ack-v1" });

      assert.equal(last.command, "pi");
      assert.equal(last.name, "Worker");
      assert.equal(last.cwd, "/repo");
      assert.equal(send.command, "pi");
      assert.equal(send.name, "Worker");
      assert.equal(send.cwd, "/repo");

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
      assert.ok(artifact.path.startsWith(`${dir}/artifacts/abc/pmux-resume/`));
      assert.match(artifact.path, new RegExp(`worker-${STAMP}\\.md$`));
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
      };
      const spec = buildPiLaunch({
        record: roleRecord(),
        task: TASK,
        localAgentDir,
        artifactDir,
        parentContact: contact,
        surface: "%24",
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
        PI_SUBAGENT_DEPTH: "1",
        PI_BLACKHOLE_SUBAGENT_MARKERS: "PI_PMUX_SESSION",
      });
      assert.equal(spec.parent, undefined);
      assert.equal(spec.report, undefined);
      assert.equal(spec.closeOnDone, undefined);

      // The spawn prompt: role block, mode hint, messaging hint, task,
      // summary instruction.
      const artifact = taskArtifact(spec);
      assert.equal(
        artifact.content,
        "\n\nYou are a worker.\n\n" +
          "Complete your task autonomously, then call pmux_done.\n\n" +
          "You can message `parent`, `Reviewer` with pmux_message; it does not end your session.\n\n" +
          `${TASK}\n\n` +
          "Your FINAL assistant message should summarize what you accomplished. Put the verdict or outcome first. Keep it short: results and findings, not your process. Follow your role's report format if it sets one.",
      );
    });
  });

  it("gives an interactive child the same report instruction as an auto-exit child", () => {
    withTempDir((dir) => {
      const spec = buildPiLaunch({
        record: roleRecord({ autoExit: false, interactive: true }),
        task: TASK,
        localAgentDir: null,
        artifactDir: join(dir, "artifacts", "sess1"),
        parentContact: { kind: "pi", siblingNames: ["Reviewer"] },
        surface: "%24",
        launchBehavior: { inheritsConversationContext: false, taskDelivery: "artifact" },
        run: { id: "abcd1234", sessionFile: SESSION_FILE, activityFile: ACTIVITY_FILE },
      });

      // The interactive child gets the same report instruction as the
      // auto-exit one, in one wording: the launch prompt carries it once.
      assert.equal(
        taskArtifact(spec).content,
        "\n\nYou are a worker.\n\n" +
          "Complete your task, then call the pmux_done tool. The user can interact with you at any time.\n\n" +
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
          },
          { surface: "%24", resume: { message: MESSAGE } },
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

  // A child that cannot tell a submission from a delivery probes the parent
  // with a second message. The footer names the result line so the child
  // reads it instead of asking, and forbids the retry the timeout would
  // otherwise tempt it into.
  it("the send footer names the result line and forbids a retry", () => {
    const footer = sendFooter("%12", "/pkg/cli.ts");
    assert.match(footer, /prints one result line/);
    assert.match(footer, /sent:true means the pointer was submitted to the parent's pane/);
    assert.match(footer, /acknowledged:true means the orchestrator read the report file/);
    assert.match(footer, /not a delivery receipt/);
    assert.match(footer, /do not resend the report and do not send anything else to check/);
    assert.match(footer, /the run wrapper re-delivers an unacknowledged report at exit/);
    assert.match(footer, /On sent:false, call the pmux_done tool without improvising retries/);
  });

  // The report shape is one shared rule set (design D6): each rule appears
  // exactly once in each footer, and the byte pins above carry the current
  // wording. A later wording change that drops a rule, or states one twice,
  // fails here even when the byte pins were updated in the same edit.
  it("the footer states each report-shape rule once", () => {
    const footers: Array<[string, string]> = [
      ["last", parentFooter("orch", "%12")],
      ["send", sendFooter("%12", "/pkg/cli.ts")],
    ];
    const rules: Array<[string, RegExp]> = [
      ["the 15-line limit", /At most 15 lines/],
      ["verdict before commit SHA", /the verdict first, then the commit SHA/],
      ["PASS or FAIL per check", /PASS or FAIL/],
      ["the commit-SHA sentence", /the parent reads them from the commit SHA/],
      ["the details-file sentence", /Put longer details in a file and name its path in the report/],
      [
        "the brief-override sentence",
        /A report format in your brief overrides this shape and limit/,
      ],
    ];
    for (const [mode, footer] of footers) {
      for (const [name, pattern] of rules) {
        const hits = footer.match(new RegExp(pattern.source, "g")) ?? [];
        assert.equal(hits.length, 1, `${mode} footer: ${name} appears ${hits.length} times`);
      }
      // The footer never asks for the files changed: the commit SHA carries
      // them, so the old field list stays out of both footers.
      assert.doesNotMatch(footer, /, the files changed,/);
    }
  });
});

/** Write one role file under `<agentsDir>/<name>.md` and return its path. */
function writeRoleFile(agentsDir: string, name: string, frontmatter: string, body = ""): string {
  mkdirSync(agentsDir, { recursive: true });
  const file = join(agentsDir, `${name}.md`);
  writeFileSync(file, `---\nname: ${name}\n${frontmatter}\n---\n\n${body}\n`);
  return file;
}

/** A role written under the process cwd's `.pi/agents` — the anchor a pi
 * parent resolves at. `.pi/` is gitignored, so the file leaves no VCS trace,
 * and the returned cleanup removes it.
 */
function processCwdRole(
  name: string,
  frontmatter: string,
  body = "You are a test agent.",
): () => void {
  writeRoleFile(join(process.cwd(), ".pi", "agents"), name, frontmatter, body);
  const file = join(process.cwd(), ".pi", "agents", `${name}.md`);
  return () => rmSync(file, { force: true });
}

describe("resolveLaunchRecord (design D6)", () => {
  it("raises the external-path errors before anything writes a file", () => {
    withTempDir((dir) => {
      const searched = agentDefinitionPaths("ghost-role", dir).join(" ");
      assert.throws(
        () =>
          resolveLaunchRecord({
            role: "ghost-role",
            anchor: dir,
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
            anchor: dir,
            overrides: { name: "NM" },
            strict: true,
          }),
        (error: Error) => error.message === `role 'no-model-role' has an empty model (${rolePath})`,
      );

      // The pi path's escape hatch (no strict): a call model fills the gap and
      // the same role resolves instead of throwing.
      const filled = resolveLaunchRecord({
        role: "no-model-role",
        anchor: dir,
        overrides: { name: "NM", model: "task-model" },
        strict: true,
      });
      assert.equal(filled.record.model, "task-model");

      // A pi parent's miss reads as a task-only launch: no throw.
      const lenient = resolveLaunchRecord({
        role: "ghost-role",
        anchor: dir,
        overrides: { name: "Ghost" },
      });
      assert.equal(lenient.definition, null);
    });
  });

  it("requireRole fails an unresolved role and still resolves a role without a model (design D1)", () => {
    withTempDir((dir) => {
      // The same unknown-role message `strict` throws, as the typed error the
      // spawn's tool result is built from.
      const searched = agentDefinitionPaths("ghost-role", dir).join(" ");
      assert.throws(
        () =>
          resolveLaunchRecord({
            role: "ghost-role",
            anchor: dir,
            overrides: { name: "Ghost" },
            requireRole: true,
          }),
        (error: unknown) =>
          error instanceof UnknownRoleError &&
          error.message === `unknown role 'ghost-role' (searched: ${searched})`,
      );

      // Only the existence is checked: a role with no `model:` resolves.
      writeRoleFile(join(dir, ".pi", "agents"), "no-model-role", "tools: read");
      const resolved = resolveLaunchRecord({
        role: "no-model-role",
        anchor: dir,
        overrides: { name: "NM" },
        requireRole: true,
      });
      assert.ok(resolved.definition, "expected the no-model role to resolve");
      assert.equal("model" in resolved.record, false);
      assert.equal(resolved.record.tools, "read");

      // A blank value names nothing: the schema's Type.String() has no
      // minLength, so the missing-value case throws here too, naming
      // `agent` (review P2) — under requireRole and strict alike.
      for (const blank of ["", "   "]) {
        assert.throws(
          () =>
            resolveLaunchRecord({
              role: blank,
              anchor: dir,
              overrides: { name: "Blank" },
              requireRole: true,
            }),
          (error: unknown) => error instanceof UnknownRoleError && /agent/.test(error.message),
        );
        assert.throws(
          () =>
            resolveLaunchRecord({
              role: blank,
              anchor: dir,
              overrides: { name: "Blank" },
              strict: true,
            }),
          (error: unknown) => error instanceof UnknownRoleError && /agent/.test(error.message),
        );
      }
    });
  });

  it("runs a fallback launch on the role's model-fallback (designs D1 and D2)", () => {
    withTempDir((dir) => {
      writeRoleFile(
        join(dir, ".pi", "agents"),
        "fb-worker",
        ["model: hyper/glm-5.3-flash", "model-fallback: opencode-go/glm-5.3-flash"].join("\n"),
        "Body.",
      );

      // The fallback model lands in the record's one `model` field: resume,
      // the spec builder and the pane title read it without new code.
      const resolved = resolveLaunchRecord({
        role: "fb-worker",
        anchor: dir,
        overrides: { name: "FB", fallback: true },
      });
      assert.equal(resolved.record.model, "opencode-go/glm-5.3-flash");

      // The conflict reads before the role even loads, so both errors sit
      // with the ones that already throw before any pane or file exists.
      assert.throws(
        () =>
          resolveLaunchRecord({
            role: "ghost-role",
            anchor: dir,
            overrides: { name: "FB", fallback: true, model: "other/model" },
          }),
        (error: Error) => error.message === "fallback conflicts with model: pass one",
      );
      assert.throws(
        () =>
          resolveLaunchRecord({
            role: "fb-worker",
            anchor: dir,
            overrides: { name: "FB", fallback: true, model: "other/model" },
          }),
        (error: Error) => error.message === "fallback conflicts with model: pass one",
      );
    });
  });

  it("fails a fallback launch of a role without the key, naming role and path", () => {
    withTempDir((dir) => {
      const rolePath = writeRoleFile(join(dir, ".pi", "agents"), "bare-worker", "tools: read");
      assert.throws(
        () =>
          resolveLaunchRecord({
            role: "bare-worker",
            anchor: dir,
            overrides: { name: "B", fallback: true },
            // The pi parent's flag: the launch fails before any pane or
            // record exists.
            requireRole: true,
          }),
        (error: Error) =>
          error.message === `role 'bare-worker' has no model-fallback (${rolePath})`,
      );

      // The CLI's flag raises the same error; a blank key reads as absent
      // (design D3) and takes the same path.
      writeRoleFile(join(dir, ".pi", "agents"), "blank-worker", "model-fallback: ");
      const blankPath = join(dir, ".pi", "agents", "blank-worker.md");
      assert.throws(
        () =>
          resolveLaunchRecord({
            role: "blank-worker",
            anchor: dir,
            overrides: { name: "B", fallback: true },
            strict: true,
          }),
        (error: Error) =>
          error.message === `role 'blank-worker' has no model-fallback (${blankPath})`,
      );
    });
  });

  it("strict applies the empty-model check to the model that applies (design D2)", () => {
    withTempDir((dir) => {
      // A role with only `model-fallback` starts in strict mode.
      writeRoleFile(
        join(dir, ".pi", "agents"),
        "fallback-only",
        "model-fallback: opencode-go/glm-5.3-flash",
      );
      const fallbackOnly = resolveLaunchRecord({
        role: "fallback-only",
        anchor: dir,
        overrides: { name: "FO", fallback: true },
        strict: true,
      });
      assert.equal(fallbackOnly.record.model, "opencode-go/glm-5.3-flash");

      // `fallback: false` is not a fallback launch: the role's empty `model:`
      // still throws the empty-model error.
      assert.throws(
        () =>
          resolveLaunchRecord({
            role: "fallback-only",
            anchor: dir,
            overrides: { name: "FO", fallback: false },
            strict: true,
          }),
        (error: Error) => /has an empty model/.test(error.message),
      );

      // Without the flag and without a call model, a role with no
      // `model-fallback` still throws the empty-model error.
      const noFbPath = writeRoleFile(join(dir, ".pi", "agents"), "empty-model-role", "tools: read");
      assert.throws(
        () =>
          resolveLaunchRecord({
            role: "empty-model-role",
            anchor: dir,
            overrides: { name: "EM" },
            strict: true,
          }),
        (error: Error) =>
          error.message === `role 'empty-model-role' has an empty model (${noFbPath})`,
      );
    });
  });

  it("a fallback launch keeps thinking and tools unchanged (design D7)", () => {
    withTempDir((dir) => {
      writeRoleFile(
        join(dir, ".pi", "agents"),
        "fb-thinking",
        [
          "model: hyper/glm-5.3-flash",
          "model-fallback: opencode-go/glm-5.3-flash",
          "tools: read",
          "thinking: medium",
          "deny-tools: claude",
        ].join("\n"),
        "Body.",
      );

      const fallback = resolveLaunchRecord({
        role: "fb-thinking",
        anchor: dir,
        overrides: { name: "FT", fallback: true },
      });
      assert.equal(fallback.record.thinking, "medium");
      assert.equal(fallback.record.tools, "read");
      assert.deepEqual(fallback.record.denyTools, ["claude"]);
      assert.equal(fallback.record.rolePrompt, "Body.");

      const normal = resolveLaunchRecord({
        role: "fb-thinking",
        anchor: dir,
        overrides: { name: "FT" },
      });
      // The record's tools and thinking do not depend on which model runs.
      assert.equal(normal.record.model, "hyper/glm-5.3-flash");
      assert.equal(normal.record.thinking, fallback.record.thinking);
      assert.equal(normal.record.tools, fallback.record.tools);
      assert.deepEqual(normal.record.denyTools, fallback.record.denyTools);
      assert.equal(normal.record.rolePrompt, fallback.record.rolePrompt);
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
        anchor: dir,
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
        anchor: dir,
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
        anchor: dir,
        overrides: { name: "R" },
      });
      assert.equal(fromRole.record.model, "role-model");
      // ...and `interactive` is the inverse of the role's auto-exit.
      assert.equal(fromRole.record.interactive, true);

      const perCall = resolveLaunchRecord({
        role: "auto-role",
        anchor: dir,
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
        anchor: dir,
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
        anchor: dir,
        overrides: { name: "CC" },
      });
      assert.equal(resolved.record.backend, "claude");
      assert.equal(resolved.record.rolePrompt, "You are Claude.");
    });
  });

  it("anchors a relative per-call cwd and the role search at the given anchor", () => {
    withTempDir((dir) => {
      // A session cwd that is not the anchor: neither value may resolve there.
      const other = join(dir, "elsewhere");
      mkdirSync(other, { recursive: true });

      const cleanup = processCwdRole("anchor-role", "model: process-model");
      try {
        const resolved = resolveLaunchRecord({
          role: "anchor-role",
          anchor: process.cwd(),
          overrides: { name: "A", cwd: "relative-dir" },
        });
        assert.equal(resolved.definition?.model, "process-model");
        assert.equal(resolved.record.cwd, join(process.cwd(), "relative-dir"));

        const rooted = resolveLaunchRecord({
          role: "ghost-role",
          anchor: other,
          overrides: { name: "A" },
        });
        assert.equal(rooted.definition, null);
      } finally {
        cleanup();
      }
    });
  });
});
