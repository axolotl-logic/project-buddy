// The orchestrator's view of the queue (#234): every open issue as the sweep
// op judges it (the same openIssues and classify, with stop labels,
// skipLabels, allowedUsers and after marks), its saved state, and its stage
// job, read from job.json or from the orchestrator's own start records. A job
// is live while its process is. Each job.json is also given to the watchdog
// (#235), with the issue's saved state for a stop.

import process from "node:process";
import { z } from "zod";
import { leaseLane } from "../claims.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import type { StatusFile } from "../job/status.ts";
import { readStatus } from "../job/status.ts";
import { openIssues } from "../ops/sweep.ts";
import type { IssueRow, SweepContext } from "../ops/sweep-verdict.ts";
import { afterDeps, classify, liveLease } from "../ops/sweep-verdict.ts";
import { OpsError } from "../process.ts";
import { interfacesOf } from "../roles/spec-writer/reply.ts";
import { prereqBehind, prereqMerged } from "../stack.ts";
import type { State } from "../state.ts";
import { readState } from "../state.ts";
import { isStopLabel } from "../stops.ts";
import { readBranchChanges } from "./branch-changes.ts";
import type { StartRecord } from "./ledger.ts";
import type { IssueJob, IssueVerdict, Prereq, SnapshotIssue } from "./queue.ts";
import { isStopped } from "./queue.ts";
import { stackable } from "./stacking.ts";
import type { WatchedJob } from "./watchdog.ts";

// The lane every orchestrator job runs in, so the next job for the same
// issue passes the sweep's lease check.
const LANE = "orchestrator";
const MS_PER_HOUR = 3_600_000;
const QUEUE_SETTINGS = z.looseObject({
  skipLabels: z.array(z.string()).nullish(),
  takeNewWork: z.unknown().optional(),
});

// The open issues, the job.json of each that has one, as the watchdog sees
// it, and each issue's saved state and label names.
interface Queue {
  issues: SnapshotIssue[];
  jobs: StatusFile[];
  watched: WatchedJob[];
  states: Map<number, State | null>;
  labels: Map<number, string[]>;
}

// True while process `pid` runs: signal 0 checks without sending.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function verdictOf(
  ctx: SweepContext,
  row: IssueRow,
  state: State | null,
): IssueVerdict {
  const verdict = classify(ctx, row);
  switch (verdict.kind) {
    case "candidate":
      return {
        kind: "candidate",
        answered: verdict.candidate.kind === "answered",
      };
    case "waiting-on-after":
      return { kind: "waiting-on-after" };
    case "live-elsewhere": {
      const lease = liveLease(state, ctx.now, ctx.leaseMs);
      return { kind: "live-elsewhere", lane: String(leaseLane(lease)) };
    }
    case "parent":
      return { kind: "parent" };
    case "skip":
    case "skipped":
      return { kind: "skip" };
    default: {
      const unknown: never = verdict;
      throw new Error(`unknown verdict ${JSON.stringify(unknown)}`);
    }
  }
}

// The issue's job: its job.json while that job runs, or else the last job
// the orchestrator started for it while that process runs.
function jobOf(
  status: StatusFile | null,
  running: boolean,
  start: StartRecord | undefined,
): IssueJob | null {
  if (status !== null && running) {
    return { live: true, stage: status.stage };
  }
  if (start !== undefined && isAlive(start.pid)) {
    return { live: true, stage: start.stage };
  }
  if (status === null) {
    return null;
  }
  return { live: false, stage: status.stage };
}

function numberOr(value: unknown): number | null {
  if (typeof value === "number") {
    return value;
  }
  return null;
}

// The `where` of each `new` interface the saved state names, or none when it
// names none or they are malformed.
function stubsOf(state: State | null): string[] {
  const { interfaces } = state ?? {};
  const saved = interfacesOf(interfaces) ?? [];
  return saved.filter((i) => i.status === "new").map((i) => i.where);
}

function issueOf(
  ctx: SweepContext,
  row: IssueRow,
  started: readonly StartRecord[],
): { issue: SnapshotIssue; watched: WatchedJob | null; state: State | null } {
  const { state } = readState(ctx.cfg, row.number);
  const status = readStatus(paths.runDir(ctx.cfg, row.number));
  const start = started.findLast((s) => s.issue === row.number);
  const running =
    status !== null && status.outcome === null && isAlive(status.pid);
  const issue: SnapshotIssue = {
    number: row.number,
    createdAt: row.createdAt,
    verdict: verdictOf(ctx, row, state),
    stage: state?.stage ?? null,
    stoppedStage: state?.stoppedStage ?? null,
    stubs: stubsOf(state),
    changed: null,
    pr: numberOr(state?.pr),
    after: afterDeps(row.body).filter((n) => ctx.openNumbers.has(n)),
    stopped: row.labels.some((label) => isStopLabel(label.name)),
    job: jobOf(status, running, start),
    stackedOn: state?.stackedOn ?? null,
    prereq: null,
    priority: null,
  };
  if (status === null) {
    return { issue, watched: null, state };
  }
  const stopped = issue.stopped || issue.stage === "stopped";
  const live = issue.job?.live === true;
  return {
    issue,
    watched: { issue: row.number, stopped, live, running, status },
    state,
  };
}

// The facts of open prerequisite `p`, from its row and saved state. One at
// publish has merged: its PR merged and only its wiki changes wait.
function openPrereq(p: SnapshotIssue, state: State | null): Prereq {
  const { number } = p;
  if (p.stage === "publish") {
    return { number, status: "merged" };
  }
  const findings = state?.findings ?? [];
  return {
    number,
    status: "open",
    // With no saved state it hasn't passed triage.
    stage: p.stage ?? "triage",
    openFindings: findings.filter((f) => f.status === "open").length,
    headSha: state?.headSha ?? null,
    stacked: p.stackedOn !== null,
    stopped: isStopped(p),
    behind: false,
  };
}

// `prereq` with whether it is behind (#328), read only when the stacking rules
// read it: `issue` waits on its after mark unstacked, and `prereq` is open and
// stackable. `closed` are the issues its after mark names that aren't open.
function withBehind(
  cfg: Config,
  issue: SnapshotIssue,
  prereq: Prereq,
  closed: readonly number[],
): Prereq {
  if (
    issue.verdict.kind !== "waiting-on-after" ||
    issue.stackedOn !== null ||
    prereq.status !== "open" ||
    !stackable(prereq) ||
    closed.length === 0
  ) {
    return prereq;
  }
  return { ...prereq, behind: prereqBehind(cfg, prereq.number, closed) };
}

// Whether closed prerequisite `number` merged, as merge's stackedQueued asks
// GitHub, or null when gh fails or replies with something unreadable, as for
// a deleted issue, so one unreadable prerequisite doesn't fail the tick.
function closedPrereq(cfg: Config, number: number): Prereq | null {
  try {
    if (prereqMerged(cfg, number)) {
      return { number, status: "merged" };
    }
  } catch (error: unknown) {
    if (
      error instanceof OpsError ||
      error instanceof SyntaxError ||
      error instanceof z.ZodError
    ) {
      return null;
    }
    throw error;
  }
  return { number, status: "closed-unmerged" };
}

// The issue's prerequisite (#290): the issue it is stacked on, or with none
// the only open issue its after mark names, or null when it can't be read.
// `closed` are the issues its after mark names that aren't open.
function prereqOf(
  cfg: Config,
  issue: SnapshotIssue,
  queue: Queue,
  closed: readonly number[],
): Prereq | null {
  let number = issue.stackedOn?.issue;
  if (number === undefined && issue.after.length === 1) {
    number = issue.after.at(0);
  }
  if (number === undefined) {
    return null;
  }
  const open = queue.issues.find((p) => p.number === number);
  if (open !== undefined) {
    const prereq = openPrereq(open, queue.states.get(number) ?? null);
    return withBehind(cfg, issue, prereq, closed);
  }
  return closedPrereq(cfg, number);
}

// The open issues and their jobs, as of `now`.
function readQueue(
  cfg: Config,
  started: readonly StartRecord[],
  now: Date,
): Queue {
  const settings = QUEUE_SETTINGS.parse(cfg);
  const rows = openIssues(cfg);
  const ctx: SweepContext = {
    cfg,
    lane: LANE,
    skipLabels: settings.skipLabels ?? [],
    takeNewWork: settings.takeNewWork !== false,
    openNumbers: new Set(rows.map((row) => row.number)),
    now: now.getTime(),
    leaseMs: cfg.leaseHours * MS_PER_HOUR,
  };
  const queue: Queue = {
    issues: [],
    jobs: [],
    watched: [],
    states: new Map(),
    labels: new Map(),
  };
  const closedAfter = new Map<number, number[]>();
  for (const row of rows) {
    closedAfter.set(
      row.number,
      afterDeps(row.body).filter((n) => !ctx.openNumbers.has(n)),
    );
    const { issue, watched, state } = issueOf(ctx, row, started);
    queue.issues.push(issue);
    queue.states.set(row.number, state);
    queue.labels.set(
      row.number,
      row.labels.map((label) => label.name),
    );
    if (watched !== null) {
      queue.jobs.push(watched.status);
      queue.watched.push(watched);
    }
  }
  for (const issue of queue.issues) {
    const closed = closedAfter.get(issue.number) ?? [];
    issue.prereq = prereqOf(cfg, issue, queue, closed);
  }
  readBranchChanges(cfg, queue.issues);
  return queue;
}

export { LANE, readQueue };
