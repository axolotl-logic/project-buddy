// @ts-check
// Recorded queue snapshots for the orchestrator's scheduler (#234), and the
// settings and clock they are scheduled with.

/** @import { ScheduleSettings, Snapshot, SnapshotIssue } from "../src/orchestrator/queue.ts" */

const NOW = new Date("2026-10-15T12:00:00.000Z");
const MINUTE_MS = 60_000;
const FIRST_ISSUE_AT = Date.parse("2026-10-01T00:00:00.000Z");
const ROOMY_JOBS = 10;
const CAPPED_JOBS = 2;
const READER_CAP = 2;
const TOKENS_PER_HOUR = 2_000_000;

/** @type {ScheduleSettings} */
const SETTINGS = {
  maxJobs: ROOMY_JOBS,
  stageCaps: {
    triage: READER_CAP,
    spec: READER_CAP,
    review: READER_CAP,
    accept: READER_CAP,
    security: READER_CAP,
  },
  tokensPerHour: TOKENS_PER_HOUR,
};

/** @type {ScheduleSettings} */
const CAPPED = { ...SETTINGS, maxJobs: CAPPED_JOBS };

// An issue's facts with none of its own: at triage with no stopped stage,
// stub files, changed files, PR, after mark, job, prerequisite or priority,
// unstacked.
const BLANK = {
  stage: "triage",
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

// The facts a fixture sets: an issue's stub files (the `where` of its `new`
// interfaces) and, for a live implementation, its branch's changed files.
/** @typedef {Partial<SnapshotIssue>} IssueFields */

// Issue #number, opened `number` minutes after the first: a runnable
// candidate with BLANK's facts, then `fields`.
/** @param {IssueFields & { number: number }} fields @returns {SnapshotIssue} */
function issue(fields) {
  const { number } = fields;
  return {
    ...BLANK,
    createdAt: new Date(FIRST_ISSUE_AT + number * MINUTE_MS).toISOString(),
    verdict: { kind: "candidate", answered: false },
    ...fields,
  };
}

// The issues, as read with no priority board unless `prioritized` (#393).
/** @param {SnapshotIssue[]} issues @param {number} [spentLastHour] @param {boolean} [prioritized] @returns {Snapshot} */
function snapshotOf(issues, spentLastHour = 0, prioritized = false) {
  return { issues, spentLastHour, prioritized };
}

const LIVE_JOB = { live: true, stage: "implement" };

// One issue at each reader stage.
const READERS = snapshotOf([
  issue({ number: 1, stage: "triage" }),
  issue({ number: 2, stage: "spec" }),
  issue({ number: 3, stage: "review" }),
  issue({ number: 4, stage: "accept" }),
  issue({ number: 5, stage: "security" }),
]);

// Three specs; a spec job already runs for #6.
const SPECS = snapshotOf([
  issue({ number: 6, stage: "spec", job: { live: true, stage: "spec" } }),
  issue({ number: 7, stage: "spec" }),
  issue({ number: 8, stage: "spec" }),
]);

// #10 is in review, its branch changing two files in src/a/; #11 and #12
// wait to implement, #11 stubbing one of those files and #12 another file in
// src/a/.
const IMPLEMENTS = snapshotOf([
  issue({
    number: 10,
    stage: "review",
    changed: ["src/a/b.ts", "src/a/c.ts"],
  }),
  issue({ number: 11, stage: "implement", stubs: ["src/a/b.ts"] }),
  issue({ number: 12, stage: "implement", stubs: ["src/a/d.ts"] }),
]);

// Two candidates at merge: #41 has the lower PR, #40's branch changes
// src/x.ts.
const MERGE_FIRST = 40;
/** @param {SnapshotIssue[]} others @returns {Snapshot} */
function mergesWith(others) {
  return snapshotOf([
    issue({
      number: MERGE_FIRST,
      stage: "merge",
      pr: 100,
      changed: ["src/x.ts"],
    }),
    issue({ number: 41, stage: "merge", pr: 90, changed: ["lib/y.ts"] }),
    ...others,
  ]);
}

// #42 waits for #40 only through its after mark: neither branch changes its
// stub.
const MERGE_BY_AFTER = mergesWith([
  issue({
    number: 42,
    stage: "spec",
    stubs: ["docs/z.md"],
    after: [MERGE_FIRST],
  }),
]);

// #43 waits for #40 only through its stub, which #40's branch changes: it has
// no after mark.
const MERGE_BY_STUBS = mergesWith([
  issue({ number: 43, stage: "triage", stubs: ["src/x.ts"] }),
]);

// #43's stub is in the same folder as #40's change, but no branch changes it.
const MERGE_BY_NEITHER = mergesWith([
  issue({ number: 43, stage: "triage", stubs: ["src/z.ts"] }),
]);

// Issues that name #40 or stub a file it changes but aren't waiting: one past
// implement, one stopped, one whose implement job runs.
const MERGE_NOT_WAITING = mergesWith([
  issue({
    number: 44,
    stage: "review",
    stubs: ["src/x.ts"],
    after: [MERGE_FIRST],
  }),
  issue({ number: 45, stage: "spec", stopped: true, after: [MERGE_FIRST] }),
  issue({ number: 46, stage: "stopped", stubs: ["src/x.ts"] }),
  issue({
    number: 47,
    stage: "implement",
    job: LIVE_JOB,
    stubs: ["src/x.ts"],
    after: [MERGE_FIRST],
  }),
]);

// Nothing depends on either merge candidate.
const MERGE_TIE = snapshotOf([
  issue({ number: 50, stage: "merge", pr: 80, changed: ["a.ts"] }),
  issue({ number: 51, stage: "accept", pr: 70, changed: ["b.ts"] }),
]);

// #60's merge job runs; #61 waits at merge and ranks first by its lower PR.
const MERGE_LIVE = snapshotOf([
  issue({
    number: 60,
    stage: "merge",
    pr: 20,
    job: { live: true, stage: "merge" },
  }),
  issue({ number: 61, stage: "merge", pr: 10 }),
]);

// Older #80 waits at merge, but #82 stubs a file only younger #81's branch
// changes, at sync, so #81 ranks first: #81's sync may not wait on #80.
const MERGE_OVER_WRITER = snapshotOf([
  issue({ number: 80, stage: "merge", pr: 30, changed: ["src/a.ts"] }),
  issue({ number: 81, stage: "sync", pr: 31, changed: ["src/b.ts"] }),
  issue({ number: 82, stage: "spec", stubs: ["src/b.ts"] }),
]);

// #85 ranks first; older #84, at fix, stubs a file oldest #83's branch, at
// merge, changes. A fix is never held on files, so no chain forms.
const MERGE_OVER_CHAIN = snapshotOf([
  issue({ number: 83, stage: "merge", pr: 32, changed: ["src/a.ts"] }),
  issue({
    number: 84,
    stage: "fix",
    pr: 33,
    stubs: ["src/a.ts"],
    changed: ["src/a.ts"],
  }),
  issue({
    number: 85,
    stage: "sync",
    pr: 34,
    changed: ["lib/x.ts", "src/c.ts"],
  }),
  issue({ number: 86, stage: "spec", stubs: ["lib/x.ts"] }),
]);

// #90 waits at merge behind #91 at `stage`, which ranks first by its lower
// PR; neither stubs a file the other's branch changes.
/** @param {string} stage @returns {Snapshot} */
function mergeBehind(stage) {
  return snapshotOf([
    issue({ number: 90, stage: "merge", pr: 41, changed: ["a.ts"] }),
    issue({ number: 91, stage, pr: 40, changed: ["b.ts"] }),
  ]);
}

// The queue's top, #92, is at checks; the first issue at a holding stage is
// #93, at accept, ahead of #94 at merge.
const MERGE_PAST_CHECKS = snapshotOf([
  issue({ number: 92, stage: "checks", pr: 10, changed: ["c.ts"] }),
  issue({ number: 93, stage: "accept", pr: 20, changed: ["d.ts"] }),
  issue({ number: 94, stage: "merge", pr: 30, changed: ["e.ts"] }),
]);

// Issues that get no decision, or a hold from their classify verdict.
const LIVE_IMPLEMENT = 70;
const NO_RUN = snapshotOf([
  issue({
    number: LIVE_IMPLEMENT,
    stage: "implement",
    job: LIVE_JOB,
    changed: ["x/a.ts"],
  }),
  issue({ number: 71, stage: "stopped" }),
  issue({ number: 72, stage: "review", stopped: true }),
  issue({ number: 73, stage: "done" }),
  issue({ number: 74, verdict: { kind: "skip" } }),
  issue({
    number: 75,
    verdict: { kind: "waiting-on-after" },
    after: [LIVE_IMPLEMENT],
  }),
  issue({
    number: 76,
    verdict: { kind: "live-elsewhere", lane: "L2" },
    stage: "review",
  }),
  issue({
    number: 77,
    verdict: { kind: "candidate", answered: true },
    stage: "spec",
  }),
  issue({ number: 78, stage: null }),
]);

export {
  CAPPED,
  IMPLEMENTS,
  issue,
  LIVE_JOB,
  MERGE_BY_AFTER,
  MERGE_BY_NEITHER,
  MERGE_BY_STUBS,
  MERGE_LIVE,
  MERGE_NOT_WAITING,
  MERGE_OVER_CHAIN,
  MERGE_OVER_WRITER,
  MERGE_PAST_CHECKS,
  MERGE_TIE,
  mergeBehind,
  NO_RUN,
  NOW,
  READERS,
  SETTINGS,
  SPECS,
  snapshotOf,
  TOKENS_PER_HOUR,
};
