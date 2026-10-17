// @ts-check
// One orchestrator tick with the config's `priority` key (#393): the tick
// reads each open issue's tier from a user-owned Projects board, one GraphQL
// query per page, and starts the work in tier order, naming each start's
// tier; a board it can't read gives one warning and the order of a config
// with no key; a malformed key fails the tick; with no key nothing changes.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import {
  CONFIG,
  configWith,
  deadPid,
  fakeGh,
  NOW,
  openWith,
  runFile,
} from "./orchestrator-world-test-kit.mjs";

const { loadConfig } = await import("../src/config.ts");
const { tick } = await import("../src/orchestrator/tick.ts");

/** @import { OpenIssue } from "./orchestrator-world-test-kit.mjs" */
/** @import { GhReply } from "./fake-gh.mjs" */

const BOARD = "alice/7";
const PRIORITIZED = configWith({ priority: { project: BOARD } });
const READ = { high: 81, none: 82, unknown: 83, low: 84 };
const FALLBACK = { spec: 91, older: 92, newer: 93 };
const PR = 3;
const NAMES_PRIORITY = /priority/u;

// The watchdog's steer and SIGTERM and the escalation agent, none of which a
// tick here is due, and a spawn whose job has already exited, so no start
// stays live for a later tick.
const DEPS = {
  configPath: CONFIG,
  now: () => NOW,
  spawn: () => deadPid(),
  runAgent: () => {
    throw new Error("unexpected escalation agent run");
  },
  steer: () => {
    throw new Error("unexpected steer");
  },
  terminate: () => {
    throw new Error("unexpected SIGTERM");
  },
};

// One board item as GitHub's GraphQL API returns it: an issue of `repo`, or
// a draft or pull request (`number` null), whose field holds `option`.
/** @param {number | null} number @param {string} repo @param {string | null} option @returns {object} */
function item(number, repo, option) {
  /** @type {object} */
  let content = {};
  if (number !== null) {
    content = { number, repository: { nameWithOwner: repo } };
  }
  let fieldValueByName = null;
  if (option !== null) {
    fieldValueByName = { name: option };
  }
  return { content, fieldValueByName };
}

// gh's answer to one page of the board's items, followed by `next` or last.
/** @param {readonly object[]} nodes @param {string | null} next @returns {GhReply} */
function page(nodes, next) {
  const pageInfo = { hasNextPage: next !== null, endCursor: next };
  const items = { pageInfo, nodes };
  return {
    when: "graphql",
    stdout: JSON.stringify({ data: { user: { projectV2: { items } } } }),
  };
}

// Each line of orchestrator.log after the first `from`, as
// `#issue stage action reason`.
/** @param {number} from @returns {string[]} */
function loggedFrom(from) {
  return fs
    .readFileSync(runFile("orchestrator.log"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .slice(from)
    .map((line) => {
      const { issue, stage, action, reason } = JSON.parse(line);
      return `#${issue} ${stage} ${action} ${reason}`;
    });
}

/** @returns {number} */
function logLength() {
  if (!fs.existsSync(runFile("orchestrator.log"))) {
    return 0;
  }
  return loggedFrom(0).length;
}

/** @returns {number} */
function graphqlCalls() {
  return fakeGh.calls().filter((args) => args.join(" ").includes("graphql"))
    .length;
}

// One tick with the config at `configPath`: its decisions and the lines it
// logged, each as `#issue stage action reason`, and its warnings.
/** @param {string} configPath @returns {{ lines: string[], logged: string[], warnings: string[] }} */
function tickWith(configPath) {
  const before = logLength();
  const { decisions, warnings } = tick(loadConfig(configPath), DEPS);
  const lines = decisions.map(
    ({ issue, stage, action, reason }) =>
      `#${issue} ${stage} ${action} ${reason}`,
  );
  return { lines, logged: loggedFrom(before), warnings };
}

/** @type {OpenIssue[]} */
const BOARDED = [
  { number: READ.high, state: { stage: "spec" } },
  { number: READ.none, state: { stage: "review", pr: PR } },
  { number: READ.unknown, state: { stage: "accept", pr: PR } },
  { number: READ.low, state: { stage: "spec" } },
];

test("a tick orders its starts by the board's tiers, read a page at a time, and logs each start's tier", () => {
  openWith(BOARDED, [
    page(
      [
        item(READ.high, "o/r", "High"),
        item(READ.none, "other/repo", "Urgent"),
        item(null, "", "Urgent"),
        item(READ.none, "o/r", null),
      ],
      "p2",
    ),
    page(
      [item(READ.low, "o/r", "low"), item(READ.unknown, "o/r", "Someday")],
      null,
    ),
  ]);
  const { lines, logged, warnings } = tickWith(PRIORITIZED);
  assert.deepEqual(lines, [
    "#81 spec started free:priority-high",
    "#84 spec started free:priority-low",
    "#83 accept started free",
    "#82 review started free",
  ]);
  assert.deepEqual(logged, lines);
  assert.deepEqual(warnings, []);
  assert.equal(graphqlCalls(), 2);
});

/** @type {OpenIssue[]} */
const UNBOARDED = [
  { number: FALLBACK.spec, state: { stage: "spec" } },
  { number: FALLBACK.older },
  { number: FALLBACK.newer },
];
const AS_TODAY = [
  "#91 spec started free",
  "#92 triage started free",
  "#93 triage started free",
];

test("a board gh can't read gives one warning naming it, and the tick schedules without priority", () => {
  openWith(UNBOARDED, [
    {
      when: "graphql",
      code: 1,
      stderr:
        "GraphQL: Your token has not been granted the required scopes to execute this query. The 'projectV2' field requires one of the following scopes: ['read:project']\n",
      keep: true,
    },
  ]);
  const { lines, warnings } = tickWith(PRIORITIZED);
  assert.deepEqual(lines, AS_TODAY);
  assert.equal(warnings.length, 1);
  assert.ok(warnings.join("").includes(BOARD), warnings.join("\n"));
});

test("a board reply the tick can't read gives one warning, and the tick schedules without priority", () => {
  for (const stdout of [
    JSON.stringify({ data: { user: { projectV2: null } } }),
    "<html>not json</html>",
  ]) {
    openWith(UNBOARDED, [{ when: "graphql", stdout, keep: true }]);
    const { lines, warnings } = tickWith(PRIORITIZED);
    assert.deepEqual(lines, AS_TODAY, stdout);
    assert.equal(warnings.length, 1, stdout);
    assert.ok(warnings.join("").includes(BOARD), warnings.join("\n"));
  }
});

test("a malformed priority key fails the tick, naming the key", () => {
  openWith(UNBOARDED);
  const malformed = configWith({ priority: { project: "alice" } });
  assert.throws(() => tick(loadConfig(malformed), DEPS), NAMES_PRIORITY);
});

test("with no priority key a tick reads no board and warns of nothing", () => {
  openWith(UNBOARDED);
  const { lines, warnings } = tickWith(CONFIG);
  assert.deepEqual(lines, AS_TODAY);
  assert.deepEqual(warnings, []);
  assert.equal(graphqlCalls(), 0);
});
