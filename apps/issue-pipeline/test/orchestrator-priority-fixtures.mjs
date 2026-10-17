// @ts-check
// Helpers shared by the scheduler's priority tests (#393): the decisions a
// recorded snapshot gets at a tick, each as one line, and the ticks to read
// them at.
import { schedule } from "../src/orchestrator/schedule.ts";
import { issue, NOW, SETTINGS, snapshotOf } from "./orchestrator-fixtures.mjs";

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

/** @param {string} a @param {string} b @returns {number} */
function byText(a, b) {
  return a.localeCompare(b);
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
  return [...seen].sort(byText);
}

// An issue saved at `stopped` after a stop in `stoppedStage`, its label gone.
/** @param {string} stoppedStage @param {Partial<SnapshotIssue> & { number: number }} fields @returns {SnapshotIssue} */
function lifted(stoppedStage, fields) {
  return issue({ stage: "stopped", stoppedStage, ...fields });
}

// Five new issues at triage, numbered from `first`, each with `fields`.
/** @param {{ number: number }} first @param {Partial<SnapshotIssue>} fields @returns {SnapshotIssue[]} */
function fiveNew({ number }, fields) {
  return Array.from({ length: 5 }, (_, at) =>
    issue({ ...fields, number: number + at, stage: null }),
  );
}

// A snapshot of `issues` with the board read, so tiers apply.
/** @param {SnapshotIssue[]} issues @returns {Snapshot} */
function boardRead(issues) {
  return snapshotOf(issues, 0, true);
}

export {
  boardRead,
  byText,
  decided,
  fiveNew,
  LATER,
  lifted,
  order,
  ROOMY,
  ranked,
  seenAt,
  TICKS,
  tickAt,
};
