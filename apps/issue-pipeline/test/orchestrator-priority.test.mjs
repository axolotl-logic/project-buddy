// @ts-check
// The orchestrator's scheduler with a Projects board's priorities (#393), on
// recorded snapshots: tiers order every start, Urgent to none; within a tier
// the issues past triage go first in stage-then-age order, then the new ones
// in an order seeded by the tick; each start names its tier; live jobs stand.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPPED, issue, snapshotOf } from "./orchestrator-fixtures.mjs";
import {
  boardRead,
  byText,
  decided,
  fiveNew,
  LATER,
  lifted,
  order,
  ROOMY,
  seenAt,
  TICKS,
  tickAt,
} from "./orchestrator-priority-fixtures.mjs";

// The places in a tick's order the tests look at.
const FIRST = 0;
const SECOND = 1;
// Where the new issues and then the next tier start, in the within-a-tier test.
const NEW_FROM = 3;
const REST_FROM = 5;

test("every start goes in tier order, Urgent to none, ahead of stage and age, and names its tier", () => {
  const snapshot = boardRead([
    issue({ number: 1, stage: "security" }),
    issue({ number: 2, stage: "review", priority: "low" }),
    issue({ number: 3, stage: "spec", priority: "medium" }),
    issue({ number: 4, stage: "implement", priority: "high" }),
    issue({ number: 5, stage: null, priority: "urgent" }),
    lifted("review", { number: 6, priority: "high" }),
    issue({ number: 7, stage: "merge", pr: 5, priority: "low" }),
  ]);
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
  const snapshot = boardRead([
    issue({
      number: 10,
      stage: "review",
      job: { live: true, stage: "review" },
    }),
    issue({ number: 11, stage: "security" }),
    issue({ number: 12, stage: "accept", priority: "low" }),
    issue({ number: 13, stage: null, priority: "high" }),
  ]);
  assert.deepEqual(decided(snapshot, CAPPED), [
    "#13 triage started free:priority-high",
    "#12 accept held global-cap",
    "#11 security held global-cap",
  ]);
});

test("within a tier the issues past triage go first, by stage then age, then the new ones", () => {
  const snapshot = boardRead([
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
  ]);
  const lines = decided(snapshot);
  assert.deepEqual(lines.slice(FIRST, NEW_FROM), [
    "#23 review started free:priority-high",
    "#24 implement started free:priority-high",
    "#21 spec started free:priority-high",
  ]);
  assert.deepEqual(lines.slice(NEW_FROM, REST_FROM).sort(byText), [
    "#20 triage started free:priority-high",
    "#22 triage started free:priority-high",
  ]);
  assert.deepEqual(lines.slice(REST_FROM), [
    "#25 review started free:priority-medium",
  ]);
});

test("a tier's new issues come in an order the tick seeds: the same within a tick, each one first at some tick", () => {
  const snapshot = boardRead(fiveNew({ number: 30 }, { priority: "high" }));
  const news = ["#30", "#31", "#32", "#33", "#34"];
  assert.deepEqual(decided(snapshot), decided(snapshot));
  const later = tickAt(LATER);
  assert.deepEqual(
    decided(snapshot, ROOMY, later),
    decided(snapshot, ROOMY, later),
  );
  for (let minutes = 0; minutes < TICKS; minutes += 1) {
    assert.deepEqual(order(snapshot, tickAt(minutes)).sort(byText), news);
  }
  assert.deepEqual(seenAt(snapshot, FIRST), news);
});

test("with a board read, new issues with no priority are seeded too, after every tier", () => {
  const snapshot = boardRead([
    ...fiveNew({ number: 41 }, {}),
    issue({ number: 40, stage: null, priority: "low" }),
  ]);
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
