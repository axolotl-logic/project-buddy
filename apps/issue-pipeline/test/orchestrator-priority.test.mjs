// @ts-check
// The orchestrator's scheduler with a Projects board's priorities (#393), on
// recorded snapshots: tiers order every start and the merge queue, Urgent to
// none; within a tier the issues past triage go first in stage-then-age
// order, then the new ones in an order seeded by the tick; each start names
// its tier; the after holds, the file gate and live jobs stand.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeRank } from "../src/orchestrator/queue.ts";
import { schedule } from "../src/orchestrator/schedule.ts";
import {
  CAPPED,
  issue,
  LIVE_JOB,
  NOW,
  SETTINGS,
  snapshotOf,
} from "./orchestrator-fixtures.mjs";

/** @import { ScheduleSettings, Snapshot, SnapshotIssue } from "../src/orchestrator/queue.ts" */

// No stage cap, so the order alone decides.
/** @type {ScheduleSettings} */
const ROOMY = { ...SETTINGS, stageCaps: {} };
const MINUTE_MS = 60_000;
// Enough ticks that a fair pick among five misses one with a chance below
// one in a billion; the scheduler is pure, so the result never changes.
const TICKS = 100;
// A tick other than NOW's, in minutes after it.
const LATER = 7;
// The places in a tick's order the tests look at.
const FIRST = 0;
const SECOND = 1;
// The live implementation and the merge others wait on through after marks.
const LIVE = 80;
const UNBLOCKS_ONE = 60;
const CHECKS_FIRST = 72;

// Each decision as `#issue stage action reason`, and a merge's queue, in the
// order made at `now`.
/** @param {Snapshot} snapshot @param {ScheduleSettings} [settings] @param {Date} [now] @returns {string[]} */
function decided(snapshot, settings = ROOMY, now = NOW) {
  return schedule(snapshot, settings, now).map((decision) => {
    const { issue: number, stage, action, reason } = decision;
    let queue = "";
    if (decision.action === "started" && decision.mergeQueue !== null) {
      queue = ` queue:${decision.mergeQueue.map((n) => `#${n}`).join(",")}`;
    }
    return `#${number} ${stage} ${action} ${reason}${queue}`;
  });
}

// The issues each decision is for, as `#issue`, in the order made at `now`.
/** @param {Snapshot} snapshot @param {Date} now @returns {string[]} */
function order(snapshot, now) {
  return schedule(snapshot, ROOMY, now).map(({ issue: n }) => `#${n}`);
}

/** @param {readonly number[]} numbers @returns {string[]} */
function ranked(numbers) {
  return numbers.map((n) => `#${n}`);
}

// The tick `minutes` minutes after NOW.
/** @param {number} minutes @returns {Date} */
function tickAt(minutes) {
  return new Date(NOW.getTime() + minutes * MINUTE_MS);
}

// The issues that come at `place` of the order across TICKS ticks, sorted.
/** @param {Snapshot} snapshot @param {number} place @returns {string[]} */
function seenAt(snapshot, place) {
  /** @type {Set<string>} */
  const seen = new Set();
  for (let minutes = 0; minutes < TICKS; minutes += 1) {
    const at = order(snapshot, tickAt(minutes)).at(place);
    if (at !== undefined) {
      seen.add(at);
    }
  }
  return [...seen].sort();
}

// An issue saved at `stopped` after a stop in `stoppedStage`, its label gone.
/** @param {string} stoppedStage @param {Partial<SnapshotIssue> & { number: number }} fields @returns {SnapshotIssue} */
function lifted(stoppedStage, fields) {
  return issue({ stage: "stopped", stoppedStage, ...fields });
}

test("every start goes in tier order, Urgent to none, ahead of stage and age, and names its tier", () => {
  const snapshot = snapshotOf(
    [
      issue({ number: 1, stage: "security" }),
      issue({ number: 2, stage: "review", priority: "low" }),
      issue({ number: 3, stage: "spec", priority: "medium" }),
      issue({ number: 4, stage: "implement", priority: "high" }),
      issue({ number: 5, stage: null, priority: "urgent" }),
      lifted("review", { number: 6, priority: "high" }),
      issue({ number: 7, stage: "merge", pr: 5, priority: "low" }),
    ],
    0,
    true,
  );
  assert.deepEqual(decided(snapshot), [
    "#5 triage started free:priority-urgent",
    "#6 review started lifted:priority-high",
    "#4 implement started free:priority-high",
    "#3 spec started free:priority-medium",
    "#7 merge started merge-first:priority-low queue:#7",
    "#2 review started free:priority-low",
    "#1 security started free",
  ]);
});

test("a higher tier takes the free slots and a live job of a lower tier keeps running", () => {
  const snapshot = snapshotOf(
    [
      issue({
        number: 10,
        stage: "review",
        job: { live: true, stage: "review" },
      }),
      issue({ number: 11, stage: "security" }),
      issue({ number: 12, stage: "accept", priority: "low" }),
      issue({ number: 13, stage: null, priority: "high" }),
    ],
    0,
    true,
  );
  assert.deepEqual(decided(snapshot, CAPPED), [
    "#13 triage started free:priority-high",
    "#12 accept held global-cap",
    "#11 security held global-cap",
  ]);
});

test("within a tier the issues past triage go first, by stage then age, then the new ones", () => {
  const snapshot = snapshotOf(
    [
      issue({ number: 20, stage: null, priority: "high" }),
      issue({ number: 21, stage: "spec", priority: "high" }),
      issue({
        number: 22,
        stage: "implement",
        verdict: { kind: "candidate", answered: true },
        priority: "high",
      }),
      issue({ number: 23, stage: "review", priority: "high" }),
      issue({ number: 24, stage: "implement", priority: "high" }),
      issue({ number: 25, stage: "review", priority: "medium" }),
    ],
    0,
    true,
  );
  const [review, implement, spec, newOne, newTwo, ...rest] = decided(snapshot);
  assert.deepEqual(
    [review, implement, spec],
    [
      "#23 review started free:priority-high",
      "#24 implement started free:priority-high",
      "#21 spec started free:priority-high",
    ],
  );
  assert.deepEqual([newOne, newTwo].sort(), [
    "#20 triage started free:priority-high",
    "#22 triage started free:priority-high",
  ]);
  assert.deepEqual(rest, ["#25 review started free:priority-medium"]);
});

// Five new issues at triage, numbered from `first`, each with `fields`.
/** @param {{ number: number }} first @param {Partial<SnapshotIssue>} fields @returns {SnapshotIssue[]} */
function fiveNew({ number }, fields) {
  return Array.from({ length: 5 }, (_, at) =>
    issue({ ...fields, number: number + at, stage: null }),
  );
}

test("a tier's new issues come in an order the tick seeds: the same within a tick, each one first at some tick", () => {
  const snapshot = snapshotOf(
    fiveNew({ number: 30 }, { priority: "high" }),
    0,
    true,
  );
  const news = ["#30", "#31", "#32", "#33", "#34"];
  assert.deepEqual(decided(snapshot), decided(snapshot));
  const later = tickAt(LATER);
  assert.deepEqual(
    decided(snapshot, ROOMY, later),
    decided(snapshot, ROOMY, later),
  );
  for (let minutes = 0; minutes < TICKS; minutes += 1) {
    assert.deepEqual(order(snapshot, tickAt(minutes)).sort(), news);
  }
  assert.deepEqual(seenAt(snapshot, FIRST), news);
});

test("with a board read, new issues with no priority are seeded too, after every tier", () => {
  const snapshot = snapshotOf(
    [
      ...fiveNew({ number: 41 }, {}),
      issue({ number: 40, stage: null, priority: "low" }),
    ],
    0,
    true,
  );
  assert.deepEqual(seenAt(snapshot, FIRST), ["#40"]);
  assert.deepEqual(seenAt(snapshot, SECOND), [
    "#41",
    "#42",
    "#43",
    "#44",
    "#45",
  ]);
});

test("with no board read, new issues keep their age order at every tick and no start names a tier", () => {
  const snapshot = snapshotOf(fiveNew({ number: 50 }, {}));
  for (let minutes = 0; minutes < TICKS; minutes += 1) {
    assert.deepEqual(decided(snapshot, ROOMY, tickAt(minutes)), [
      "#50 triage started free",
      "#51 triage started free",
      "#52 triage started free",
      "#53 triage started free",
      "#54 triage started free",
    ]);
  }
});

test("the merge queue ranks by tier before what each merge unblocks", () => {
  const snapshot = snapshotOf(
    [
      issue({
        number: UNBLOCKS_ONE,
        stage: "merge",
        pr: 10,
        changed: ["a.ts"],
      }),
      issue({
        number: 61,
        stage: "merge",
        pr: 20,
        changed: ["b.ts"],
        priority: "low",
      }),
      issue({ number: 62, stage: "spec", after: [UNBLOCKS_ONE] }),
    ],
    0,
    true,
  );
  assert.deepEqual(ranked(mergeRank(snapshot.issues)), ["#61", "#60"]);
  assert.deepEqual(decided(snapshot), [
    "#61 merge started merge-first:priority-low queue:#61,#60",
    "#60 merge held merge-order:#61",
    "#62 spec started free",
  ]);
});

/** @param {SnapshotIssue[]} issues @param {Date} now @returns {string[]} */
function mergesAt(issues, now) {
  return decided(snapshotOf(issues, 0, true), ROOMY, now).filter((line) =>
    line.includes(" merge "),
  );
}

test("within a tier the merge queue keeps its order: what it unblocks, then the lower PR, then the number", () => {
  const issues = [
    issue({ number: 70, stage: "merge", pr: 30, priority: "high" }),
    issue({ number: 71, stage: "accept", pr: 20, priority: "high" }),
    issue({
      number: CHECKS_FIRST,
      stage: "checks",
      pr: 40,
      priority: "high",
    }),
    issue({ number: 73, stage: "spec", after: [CHECKS_FIRST] }),
    issue({ number: 74, stage: "merge", pr: 1, priority: "medium" }),
  ];
  assert.deepEqual(ranked(mergeRank(issues)), ["#72", "#71", "#70", "#74"]);
  assert.deepEqual(mergesAt(issues, NOW), [
    "#70 merge held merge-order:#71",
    "#74 merge held merge-order:#71",
  ]);
  assert.deepEqual(mergesAt(issues, tickAt(LATER)), mergesAt(issues, NOW));
});

test("a higher tier is still held by its after mark and by a live branch that changes its stub", () => {
  const snapshot = snapshotOf(
    [
      issue({
        number: LIVE,
        stage: "implement",
        job: LIVE_JOB,
        changed: ["src/a.ts"],
      }),
      issue({
        number: 81,
        stage: "implement",
        stubs: ["src/a.ts"],
        priority: "urgent",
      }),
      issue({
        number: 82,
        verdict: { kind: "waiting-on-after" },
        after: [LIVE],
        priority: "urgent",
      }),
      issue({ number: 83, stage: "spec", priority: "low" }),
      issue({ number: 84, stage: "spec", priority: "high" }),
    ],
    0,
    true,
  );
  assert.deepEqual(decided(snapshot, CAPPED), [
    "#81 implement held files-overlap:#80",
    "#82 triage held after:#80",
    "#84 spec started free:priority-high",
    "#83 spec held global-cap",
  ]);
});
