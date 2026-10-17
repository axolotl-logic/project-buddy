// @ts-check
// The orchestrator's merge queue and holds with a Projects board's priorities
// (#393), on recorded snapshots: the queue ranks by tier first and stays
// deterministic within a tier; the after holds and the file gate stand for
// every tier.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeRank } from "../src/orchestrator/queue.ts";
import { CAPPED, issue, LIVE_JOB, NOW } from "./orchestrator-fixtures.mjs";
import {
  boardRead,
  decided,
  LATER,
  ROOMY,
  ranked,
  tickAt,
} from "./orchestrator-priority-fixtures.mjs";

/** @import { SnapshotIssue } from "../src/orchestrator/queue.ts" */

// The live implementation and the merges others wait on through after marks.
const LIVE = 80;
const UNBLOCKS_ONE = 60;
const CHECKS_FIRST = 72;

test("the merge queue ranks by tier before what each merge unblocks", () => {
  const snapshot = boardRead([
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
  ]);
  assert.deepEqual(ranked(mergeRank(snapshot.issues)), ["#61", "#60"]);
  assert.deepEqual(decided(snapshot), [
    "#61 merge started merge-first:priority-low queue:#61,#60",
    "#60 merge held merge-order:#61",
    "#62 spec started free",
  ]);
});

/** @param {SnapshotIssue[]} issues @param {Date} now @returns {string[]} */
function mergesAt(issues, now) {
  return decided(boardRead(issues), ROOMY, now).filter((line) =>
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
  const snapshot = boardRead([
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
  ]);
  assert.deepEqual(decided(snapshot, CAPPED), [
    "#81 implement held files-overlap:#80",
    "#82 triage held after:#80",
    "#84 spec started free:priority-high",
    "#83 spec held global-cap",
  ]);
});
