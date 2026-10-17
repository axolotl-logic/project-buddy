// @ts-check
// The orchestrator's view of the queue (#234): the sweep's verdicts and each
// issue's saved state, and rule 2's job liveness from job.json and from the
// orchestrator's own start records.
import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import {
  cfg,
  deadPid,
  leaseOf,
  NOW,
  OTHERS_PID,
  openWith,
  writeJob,
} from "./orchestrator-world-test-kit.mjs";

const { readQueue } = await import("../src/orchestrator/snapshot.ts");

/** @import { StartRecord } from "../src/orchestrator/ledger.ts" */
/** @import { SnapshotIssue } from "../src/orchestrator/queue.ts" */
/** @import { GhReply } from "./fake-gh.mjs" */

const ISSUE = { fresh: 1, elsewhere: 2, after: 3, stopped: 4, mine: 5 };
const JOB = {
  running: 11,
  deadPid: 12,
  ended: 13,
  startedOnly: 14,
  startedDead: 15,
  others: 16,
};
const PR = 70;
const CLOSED = 99;
// An issue's facts with none of its own: no stopped stage, stub files,
// changed files, PR, after mark, stop, job, stack, prerequisite or priority.
const BASE = {
  stoppedStage: null,
  stubs: [],
  changed: null,
  pr: null,
  after: [],
  stopped: false,
  job: null,
  stackedOn: null,
  prereq: null,
  priority: null,
};
// The fresh issue as the after issue's prerequisite: open, with no state.
const FRESH_PREREQ = {
  number: ISSUE.fresh,
  status: "open",
  stage: "triage",
  openFindings: 0,
  headSha: null,
  stacked: false,
  stopped: false,
  behind: false,
};

/** @param {number} issue @param {number} pid @returns {StartRecord} */
function started(issue, pid) {
  return { issue, stage: "spec", pid, at: NOW.toISOString() };
}

test("each open issue carries the sweep's verdict, its saved stage and PR, and its open after marks, but no saved files", () => {
  openWith([
    { number: ISSUE.fresh },
    {
      number: ISSUE.elsewhere,
      labels: ["agent:working"],
      state: {
        stage: "implement",
        files: ["src/a.ts"],
        pr: PR,
        lease: leaseOf("other"),
      },
      reads: 2,
    },
    {
      number: ISSUE.after,
      body: `<!-- agent-pipeline:after ${ISSUE.fresh},${CLOSED} -->`,
    },
    {
      number: ISSUE.stopped,
      labels: ["agent:stopped-error"],
      state: { stage: "fix" },
    },
    {
      number: ISSUE.mine,
      labels: ["agent:working"],
      state: { stage: "review", lease: leaseOf("orchestrator") },
      reads: 2,
    },
  ]);
  const { issues, jobs } = readQueue(cfg, [], NOW);
  const facts = issues.map(({ createdAt: _, ...rest }) => rest);
  assert.deepEqual(facts, [
    {
      ...BASE,
      number: ISSUE.fresh,
      verdict: { kind: "candidate", answered: false },
      stage: null,
    },
    {
      ...BASE,
      number: ISSUE.elsewhere,
      verdict: { kind: "live-elsewhere", lane: "other" },
      stage: "implement",
      pr: PR,
    },
    {
      ...BASE,
      number: ISSUE.after,
      verdict: { kind: "waiting-on-after" },
      stage: null,
      after: [ISSUE.fresh],
      prereq: FRESH_PREREQ,
    },
    {
      ...BASE,
      number: ISSUE.stopped,
      verdict: { kind: "skip" },
      stage: "fix",
      stopped: true,
    },
    {
      ...BASE,
      number: ISSUE.mine,
      verdict: { kind: "candidate", answered: false },
      stage: "review",
    },
  ]);
  assert.deepEqual(jobs, []);
});

test("a job is live while its job.json has no outcome and its pid runs, or while a job the orchestrator started runs", () => {
  const running = writeJob({
    issue: JOB.running,
    stage: "implement",
    pid: process.pid,
  });
  writeJob({ issue: JOB.deadPid, stage: "fix", pid: deadPid() });
  writeJob({
    issue: JOB.ended,
    stage: "review",
    pid: process.pid,
    ended: true,
  });
  writeJob({ issue: JOB.others, stage: "checks", pid: OTHERS_PID });
  const numbers = Object.values(JOB);
  openWith(numbers.map((number) => ({ number })));
  const starts = [
    started(JOB.startedOnly, process.pid),
    started(JOB.startedDead, deadPid()),
  ];
  const { issues, jobs } = readQueue(cfg, starts, NOW);
  assert.deepEqual(
    issues.map((issue) => [issue.number, issue.job]),
    [
      [JOB.running, { live: true, stage: "implement" }],
      [JOB.deadPid, { live: false, stage: "fix" }],
      [JOB.ended, { live: false, stage: "review" }],
      [JOB.startedOnly, { live: true, stage: "spec" }],
      [JOB.startedDead, null],
      [JOB.others, { live: true, stage: "checks" }],
    ],
  );
  // Every job.json goes to the ledger, the running one as written.
  assert.deepEqual(
    jobs.map((job) => job.issue),
    [JOB.running, JOB.deadPid, JOB.ended, JOB.others],
  );
  assert.deepEqual(jobs[0], running);
});

// A prerequisite and its dependents (#290): #21 waits on #20 through its
// after mark, #22 is stacked on #20, #23 on closed #9 and #24 on #25, which
// is at publish. #20 is stacked on #9 too, so #9 is looked up twice.
const STACK = {
  prereq: 20,
  waiting: 21,
  stacked: 22,
  onClosed: 23,
  closed: 9,
  onPublished: 24,
  published: 25,
};
const HEAD = "cccccccccccccccc";
// #20 as the prerequisite of #21 and #22: open at checks, stacked itself.
const STACK_PREREQ = {
  number: STACK.prereq,
  status: "open",
  stage: "checks",
  openFindings: 1,
  headSha: HEAD,
  stacked: true,
  stopped: false,
  behind: false,
};
/** @param {number} issue @returns {{ issue: number, headSha: string }} */
function stackedOn(issue) {
  return { issue, headSha: "aaaaaaaaaaaaaaaa" };
}

/** @param {readonly GhReply[]} closedReplies @returns {SnapshotIssue[]} */
function readStacks(closedReplies) {
  const after = `<!-- agent-pipeline:after ${STACK.prereq} -->`;
  const prereqState = {
    stage: "checks",
    headSha: HEAD,
    findings: [{ status: "open" }, { status: "fixed" }],
    stackedOn: stackedOn(STACK.closed),
  };
  openWith(
    [
      { number: STACK.prereq, state: prereqState },
      { number: STACK.waiting, body: after },
      {
        number: STACK.stacked,
        state: { stage: "merge", stackedOn: stackedOn(STACK.prereq) },
      },
      {
        number: STACK.onClosed,
        state: { stage: "merge", stackedOn: stackedOn(STACK.closed) },
      },
      {
        number: STACK.onPublished,
        state: { stage: "merge", stackedOn: stackedOn(STACK.published) },
      },
      { number: STACK.published, state: { stage: "publish" } },
    ],
    closedReplies,
  );
  return readQueue(cfg, [], NOW).issues;
}

/** @param {readonly SnapshotIssue[]} issues @param {number} number @returns {unknown} */
function prereqOf(issues, number) {
  return issues.find((issue) => issue.number === number)?.prereq;
}

test("each issue carries what it is stacked on and its prerequisite's facts", () => {
  const issues = readStacks([]);
  assert.deepEqual(prereqOf(issues, STACK.waiting), STACK_PREREQ);
  assert.deepEqual(prereqOf(issues, STACK.stacked), STACK_PREREQ);
  assert.deepEqual(
    issues.find((issue) => issue.number === STACK.stacked)?.stackedOn,
    stackedOn(STACK.prereq),
  );
  assert.deepEqual(prereqOf(issues, STACK.onPublished), {
    number: STACK.published,
    status: "merged",
  });
});

test("a stacked issue's closed prerequisite is merged when GitHub says so, and otherwise closed unmerged", () => {
  const merged = readStacks([
    {
      when: "agent/issue-9 --state merged",
      stdout: '[{"number":41}]',
      keep: true,
    },
  ]);
  assert.deepEqual(prereqOf(merged, STACK.onClosed), {
    number: STACK.closed,
    status: "merged",
  });
  const closed = readStacks([
    { when: "agent/issue-9 --state merged", stdout: "[]", keep: true },
    {
      when: "api repos/o/r/issues/9",
      stdout: '{"state":"closed","reason":"not_planned"}',
      keep: true,
    },
  ]);
  assert.deepEqual(prereqOf(closed, STACK.onClosed), {
    number: STACK.closed,
    status: "closed-unmerged",
  });
});

test("a stacked issue whose closed prerequisite GitHub can't read has no prerequisite, and the rest of the queue is still read", () => {
  const issues = readStacks([
    { when: "agent/issue-9 --state merged", stdout: "[]", keep: true },
    {
      when: "api repos/o/r/issues/9",
      stderr: "gh: Not Found (HTTP 404)",
      code: 1,
      keep: true,
    },
  ]);
  assert.equal(prereqOf(issues, STACK.onClosed), null);
  assert.equal(prereqOf(issues, STACK.prereq), null);
  assert.deepEqual(prereqOf(issues, STACK.waiting), STACK_PREREQ);
});
