// @ts-check
// The facts the orchestrator's file gate reads from the queue (#390): each
// issue's stub files, the `where` of the `new` interfaces in its saved state,
// and each live implementation's changed files, read from its branch on
// GitHub against the merge base with the base branch, or with the
// prerequisite head it is stacked on. A branch that can't be read changes
// nothing, and the rest of the queue is still read. Saved files and a body's
// files line are ignored.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { z } from "zod";
import { NOW as SCHEDULE_NOW, SETTINGS } from "./orchestrator-fixtures.mjs";
import { cfg, NOW, openWith, root } from "./orchestrator-world-test-kit.mjs";

const { readQueue } = await import("../src/orchestrator/snapshot.ts");
const { schedule } = await import("../src/orchestrator/schedule.ts");
const { paths } = await import("../src/config.ts");

/** @import { OpenIssue } from "./orchestrator-world-test-kit.mjs" */

// A live implementation at checks; one stacked on it, at review; one at
// checks with no branch; issues waiting to implement.
const LIVE = 40;
const STACKED = 41;
const BRANCHLESS = 42;
const WAITING = 43;
const MALFORMED = 44;
const OLD_FILES = 45;
const NO_STUBS = 46;
const SEED = `${root}/stubs-seed`;
const COMMIT = "git -c user.email=a@b -c user.name=a commit -q";
const LIVE_FILES = ["src/a.ts", "src/b.ts"];
const STACKED_FILES = ["src/c.ts"];

// The facts the gate reads, or undefined when the issue lacks them.
const GATE_FACTS = z.object({
  stubs: z.array(z.string()),
  changed: z.array(z.string()).nullable(),
});

/** @param {string} command @returns {string} */
function sh(command) {
  const r = spawnSync("bash", ["-c", command], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${command}\n${r.stderr}`);
  }
  return r.stdout.trim();
}

// Pushes issue `n`'s branch, cut from `from`, with one commit adding `files`,
// and returns its head.
/** @param {number} n @param {string} from @param {readonly string[]} files @returns {string} */
function pushBranch(n, from, files) {
  const add = files.map((file) => `echo ${n} > ${file}`).join(" && ");
  sh(
    `cd ${SEED} && git checkout -qb agent/issue-${n} ${from} && mkdir -p src && ${add} && git add -A && ${COMMIT} -m "issue ${n}" && git push -q origin agent/issue-${n}`,
  );
  return sh(`git -C ${SEED} rev-parse HEAD`);
}

// The orchestrator's host has the shared clone, cloned before any branch here
// was pushed, so the read must fetch what it compares.
sh(`git clone -q ${root}/origin.git ${paths.clone(cfg)}`);
sh(`git clone -q ${root}/origin.git ${SEED}`);
const LIVE_HEAD = pushBranch(LIVE, "integration", LIVE_FILES);
pushBranch(STACKED, `agent/issue-${LIVE}`, STACKED_FILES);
pushBranch(WAITING, "integration", ["src/w.ts"]);
// The base moves on after the branches were cut: a change no branch makes.
sh(
  `cd ${SEED} && git checkout -q integration && mkdir -p src && echo base > src/base-only.ts && git add -A && ${COMMIT} -m "base moves" && git push -q origin integration`,
);

// One of a saved state's interfaces, `status` at `where`.
/** @param {string} where @param {string} [status] @returns {object} */
function iface(where, status = "new") {
  return {
    name: `entry in ${where}`,
    kind: "function",
    where,
    status,
    signature: "entry(): void",
    behaviours: [],
  };
}

const LIVE_ISSUE = { number: LIVE, state: { stage: "checks", pr: 1 } };
const STACKED_ISSUE = {
  number: STACKED,
  state: {
    stage: "review",
    pr: 2,
    stackedOn: { issue: LIVE, headSha: LIVE_HEAD },
  },
};
const WAITING_ISSUE = {
  number: WAITING,
  state: {
    stage: "implement",
    interfaces: [
      iface("src/b.ts"),
      iface("src/e.ts"),
      iface("src/x.ts:12", "existing"),
      iface("src/y.ts:3", "changed"),
    ],
  },
};

// Each issue's gate facts, by number, from one read of the queue of `issues`.
/** @param {readonly OpenIssue[]} issues @returns {Map<number, unknown>} */
function gateFacts(issues) {
  openWith(issues);
  const read = readQueue(cfg, [], NOW).issues;
  return new Map(
    read.map((issue) => {
      const facts = GATE_FACTS.safeParse(issue).data;
      if (facts?.changed === undefined || facts.changed === null) {
        return [issue.number, facts];
      }
      return [issue.number, { ...facts, changed: facts.changed.toSorted() }];
    }),
  );
}

test("an issue's stub files are the paths of the new interfaces its saved state names", () => {
  const facts = gateFacts([
    WAITING_ISSUE,
    {
      number: MALFORMED,
      state: { stage: "implement", interfaces: [{ where: "src/m.ts" }] },
    },
    { number: NO_STUBS, state: { stage: "implement" } },
  ]);
  assert.deepEqual(facts.get(WAITING), {
    stubs: ["src/b.ts", "src/e.ts"],
    changed: null,
  });
  assert.deepEqual(facts.get(MALFORMED), { stubs: [], changed: null });
  assert.deepEqual(facts.get(NO_STUBS), { stubs: [], changed: null });
});

test("a live implementation's changed files are its branch's own, from the base or the prerequisite head it is stacked on", () => {
  const facts = gateFacts([LIVE_ISSUE, STACKED_ISSUE, WAITING_ISSUE]);
  assert.deepEqual(facts.get(LIVE), { stubs: [], changed: LIVE_FILES });
  assert.deepEqual(facts.get(STACKED), { stubs: [], changed: STACKED_FILES });
  // Not a live implementation: its branch isn't read.
  assert.deepEqual(facts.get(WAITING), {
    stubs: ["src/b.ts", "src/e.ts"],
    changed: null,
  });
});

test("a live implementation with no branch on GitHub changes nothing, and the rest of the queue is still read", () => {
  const branchless = { number: BRANCHLESS, state: { stage: "checks", pr: 3 } };
  const facts = gateFacts([LIVE_ISSUE, branchless, WAITING_ISSUE]);
  assert.deepEqual(facts.get(BRANCHLESS), { stubs: [], changed: null });
  assert.deepEqual(facts.get(LIVE), { stubs: [], changed: LIVE_FILES });
  assert.deepEqual([...facts.keys()], [LIVE, BRANCHLESS, WAITING]);
});

test("with no issue that has stub files, no branch is read and every changed is null", () => {
  const facts = gateFacts([
    LIVE_ISSUE,
    STACKED_ISSUE,
    { number: NO_STUBS, state: { stage: "implement" } },
  ]);
  assert.deepEqual(facts.get(LIVE), { stubs: [], changed: null });
  assert.deepEqual(facts.get(STACKED), { stubs: [], changed: null });
  assert.deepEqual(facts.get(NO_STUBS), { stubs: [], changed: null });
});

test("saved files and a files line are ignored: implements start or wait by their stubs alone", () => {
  openWith([
    LIVE_ISSUE,
    WAITING_ISSUE,
    {
      number: OLD_FILES,
      body: "Do the part.\n\nFiles: `src/**`\n\nPart of #1.",
      state: {
        stage: "implement",
        files: ["src/**"],
        interfaces: [iface("src/f.ts")],
      },
    },
    {
      number: NO_STUBS,
      body: "Files: `src/a.ts`",
      state: { stage: "implement" },
    },
  ]);
  const { issues } = readQueue(cfg, [], NOW);
  const decided = schedule(
    { issues, spentLastHour: 0, prioritized: false },
    SETTINGS,
    SCHEDULE_NOW,
  )
    .filter(({ stage }) => stage === "implement")
    .map(({ issue, action, reason }) => `#${issue} ${action} ${reason}`);
  assert.deepEqual(decided, [
    `#${WAITING} held files-overlap:#${LIVE}`,
    `#${OLD_FILES} started free`,
    `#${NO_STUBS} started free`,
  ]);
});
