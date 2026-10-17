## Behaviour

1. **Config key.** A repo config may set `priority: { "project": "<owner>/<number>", "field": "<name>" }`. `field` is optional and defaults to `"Priority"`. If `priority` is left out or `null`, a tick reads no board (it makes no `gh api graphql` call), returns `warnings: []`, and every decision and log line is exactly as it is today. That includes new issues, which keep their stage-then-age order with no shuffle. A `priority` key that doesn't match this shape (for example `{ "project": "alice" }`) makes `tick` throw an error whose message names `priority`. `repos/example.json` shows the key as `"priority": null`.
2. **Board read.** With the key set, each tick reads the user-owned Projects board `<owner>/<number>` once, with one `gh api graphql` call per page of 100 items, following `pageInfo.hasNextPage`/`endCursor`. It keeps only the items whose content is an Issue of the config's `repo`. Items from another repo, draft issues, pull requests and null nodes are ignored. An issue's tier is its single-select value in the field: `Urgent`, `High`, `Medium` or `Low`, matched after trimming and ignoring case. An open issue that isn't on the board, has no value, or has any other option (such as `Someday`) has no tier.
3. **Start order.** When the board was read, every start is decided in tier order: Urgent, High, Medium, Low, then no tier. A tier outranks both stage and age. A higher tier takes the free `maxJobs`/stage-cap slots first.
4. **Within a tier.** Issues past triage go first, in today's order (later stage first, then older: `byStageThenAge`). Then come the tier's new issues, those whose next job is `triage`, including issues with answered questions. When the board was read this applies to the no-tier group too.
5. **Seeded pick.** The order of a tier's new issues comes from a seed derived from the tick's `now` and each issue's number. `schedule(snapshot, settings, now)` gives the same result for the same snapshot and `now`, so it stays a pure function. Across ticks the order varies: among 5 new issues of one tier, each comes first at some tick within 100 consecutive one-minute ticks.
6. **Merge queue.** `mergeRank` ranks the merge-ready issues by tier first (Urgent … none), then by how many waiting issues depend on them, then by lower PR, then by lower issue number. The order is deterministic and does not depend on `now`. `--merge-queue`, the `merge-order:#M` holds and `mergeHolders` all follow this order.
7. **Nothing preempted, holds stand.** A live job of a lower tier keeps running and gets no decision. The global and stage caps, the rate limit, `after:#M` holds, stacking holds and the `files-overlap:#M` gate apply to every tier unchanged.
8. **Reasons.** A start whose issue has a tier gets the reason `<reason>:priority-<tier>`, both in its `Decision` and in its `orchestrator.log` line, for example `free:priority-high`, `lifted:priority-high` or `merge-first:priority-low`. A start with no tier keeps the bare `free`, `merge-first` or `lifted`. Held reasons don't change.
9. **Unreadable board.** If the board can't be read, the tick returns exactly one warning in `TickResult.warnings`, naming the board (`<owner>/<number>`), and schedules as if the key were unset (as in item 1, with no tier suffix and no shuffle). This covers gh exiting non-zero (a missing `read:project` scope, a network error), a reply that isn't JSON, and a reply without the board (`projectV2: null`). `orchestrate` writes each warning to stderr as `orchestrate: <warning>`, and the tick goes on.

## Out of scope

- GitHub's built-in issue Priority field, organization-owned boards, and labels as a priority source.
- Preempting or stopping live jobs. Changing the caps, the rate limit, the watchdog, the escalation agent or `startGate`'s restart path. A restart is admitted as today, with no tier ordering of its own.
- Writing to the board, or creating the board or its field.
- The sweep's lanes and `ops.merge`'s own lowest-PR order without `--merge-queue`.
- Releasing or installing the pipeline.

## Design

**Modules** (all in `apps/issue-pipeline/src/orchestrator/`):

- `priority.ts` (stub committed). This is the deep module that alone knows where a tier comes from: the config key's zod schema, the GraphQL query, paging, the repo filter, option matching and the error classification. Its interface is `readPriorities(cfg: Config): Priorities`, where `Priorities = { kind: "off" } | { kind: "read"; tiers: ReadonlyMap<number, Tier> } | { kind: "unread"; warning: string }`.
  - Parse `cfg` with a schema such as `z.looseObject({ priority: z.object({ project: z.string().regex(OWNER_NUMBER), field: z.string().min(1).default("Priority") }).nullable().optional() })`.
  - A parse failure throws a ZodError whose path names `priority`. That is a config error that fails the tick, like `ORCHESTRATOR_SETTINGS.parse` in `tick.ts:245` and a malformed `jobRoles`.
  - `null` or a missing key returns `{kind:"off"}` with no gh call.
  - Each page is one `ghJson(cfg, ["api", "graphql", "-f", "query=…", "-F"/"-f" variables])` call (`src/github.ts:95`), with the query `query($owner:String!,$number:Int!,$field:String!,$cursor:String){user(login:$owner){projectV2(number:$number){items(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{content{... on Issue{number repository{nameWithOwner}}} fieldValueByName(name:$field){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}`. Use no aliases and no `--jq`: the tick test's recorded replies use exactly this wire shape.
  - Parse each reply with a zod schema. Keep `nodes` entries, `content`, `fieldValueByName` and `name` nullable, as in GitHub's schema.
  - Catch `OpsError`, `SyntaxError` and `ZodError` from the page loop, and only those, and return `{kind:"unread", warning}`. The warning names the board and the cause, for example `priority board alice/7 unread, scheduling without priority: <message>`. `closedPrereq` in `snapshot.ts` does the same.
  - No `biome.jsonc` override is needed: like `branch-changes.ts`, it calls gh only through `src/github.ts`.
- `tiers.ts` (new, pure; the name is the implementer's choice). It holds `tierIndex(tier: Tier | null)` (Urgent 0 … Low 3, none 4) and the start order: tier, then past-triage issues by `byStageThenAge`, then new issues by a seeded key.
  - The seed is a small integer hash such as FNV-1a or mulberry32 over `${now.toISOString()}#${issue.number}`, ties broken by `byAge`.
  - It needs its own module because `queue.ts` (295 lines), `schedule.ts` (293), `snapshot.ts` (299) and `tick.ts` (300) are at or near the 300-line limit (CONTRIBUTING "Limits").
- `queue.ts`:
  - `Tier` (`:51`), `SnapshotIssue.priority` (`:79`) and `Snapshot.prioritized` (`:85`) are already stubbed.
  - Change `StartReason` (`:115`) to a template type, `` `${"free" | "merge-first" | "lifted"}` | `${"free" | "merge-first" | "lifted"}:priority-${Tier}` ``. Make `startReason` (`:145`) append the suffix when `issue.priority !== null`.
  - Make `mergeRank` (`:239`) compare `tierIndex` before the dependents count (`:248`). `mergeHolders` (`:260`) and the queue then follow unchanged.
- `schedule.ts`: in `schedule()` (`:255`), replace `.sort(byStageThenAge)` (`:268`) with the tier start order when `snapshot.prioritized`. Otherwise keep `byStageThenAge` exactly. `decide` (`:199`, reason at `:224`) needs nothing more than `startReason`. `startGate` is unchanged.
- `snapshot.ts`:
  - `readQueue` (`:250`) calls `readPriorities(cfg)` once and sets each issue's `priority` in `issueOf` (`:148`, now `null`) from `tiers`.
  - It returns `prioritized` (`kind === "read"`) and `warnings` (the `unread` warning, else `[]`) on its `Queue`.
  - Trim the file to stay ≤ 300 lines.
- `tick.ts`:
  - Use the queue's `prioritized` in the snapshot (`:255`, now `false`).
  - Return its `warnings` in `TickResult` (`:237`, returned at `:296`, now `[]`).
  - The file is at 300 lines, so move a helper out, such as `jobArgv`/`startJob` or `stopOf`, to make room.
- `src/orchestrate.ts`: `tickOnce` (`:116`) writes each `warnings` entry to stderr as `orchestrate: <warning>\n`. This stays a thin adapter, as it does for a tick that fails.
- `repos/example.json`: add `"priority": null` beside the orchestrator keys (`:31-41`).
- `apps/issue-pipeline/README.md`: the orchestrator row (`:16`) names `priority.ts` and the tier order, and the token note (`:46`) says the token needs the `read:project` scope when `priority` is set. These are docs, so no test drives them; the wiki changes are under "Wiki updates".

**Why `prioritized`.** The scheduler must tell "board read, this issue has no tier" from "no board". Without a board, item 1 promises today's order, with no shuffle of new issues. With a board read, the no-tier group is the last tier and is seeded too, as the issue's "if no lows then unlabeled" asks.

**Design it twice** (CONTRIBUTING "Design"):

- (a) `readPriorities` returns a `Map` that is empty on failure and logs itself, as triage suggested. (b) The discriminated union above. **Chose (b).** An empty map can't tell an unread board from an empty one. The tick, not the reader, owns where the warning goes, since `orchestrator.log` lines all carry an issue number. A union also beats a bag of optional fields (CONTRIBUTING "Types").
- For ordering: (a) put the tier into `byStageThenAge`. (b) Use a separate start-order function. **Chose (b).** `byStageThenAge` stays the in-tier order, `startGate`/restarts keep it, and the seeded part needs `now`, which a two-argument comparator can't take.

**Practices followed.**

- APoSD deep module and information hiding: only `priority.ts` knows the board, so the built-in field can replace it there alone.
- Pull complexity down: paging and the error classes stay inside `priority.ts`.
- Define errors out of existence: an unreadable board is a value, not an exception, and only a malformed config throws.
- Zod at the boundary, for both the config and the GraphQL reply.
- No `as`, `!`, `any` or `satisfies`. Exhaustive switches with `never` (the tick switches over `Priorities.kind`).
- Explicit parameter and return types, named top-level `u` regexes, and the 300-line and 50-line limits (CONTRIBUTING "Types", "Lint").
- Wiki decisions: `stage-jobs-replace-lanes`, `merge-order` (the queue still ranks by dependents within a tier) and `no-file-lists` (the file gate is untouched), all in Issue-Pipeline.md.

**Departure from triage.** The `priority-first` entry goes in **Issue-Pipeline.md**, where every orchestrator decision lives (`merge-order`, `no-file-lists`, `orchestrator-closes-parents`), not in Decisions-Code-and-tooling.md, which holds repo-wide code and tooling rules.

**Retries.** `ghIsRead` (`src/github.ts:34`) counts any `api` call with `-f`/`-F` as a write, so the GraphQL read isn't retried by `gh()`. A failed read falls back for one tick (item 9), which is acceptable. Don't reshape the call to dodge this.

## Test interfaces

- **`priority` config key** (config, new; `apps/issue-pipeline/src/orchestrator/priority.ts`). `"priority": { "project": "<owner>/<number>", "field"?: string } | null` in a repo config, driven through `tick`. Its tests check these Behaviour items:
  - **Config key.** A repo config may set `priority: { "project": "<owner>/<number>", "field": "<name>" }`. `field` is optional and defaults to `"Priority"`. If `priority` is left out or `null`, a tick reads no board (it makes no `gh api graphql` call), returns `warnings: []`, and every decision and log line is exactly as it is today. That includes new issues, which keep their stage-then-age order with no shuffle. A `priority` key that doesn't match this shape (for example `{ "project": "alice" }`) makes `tick` throw an error whose message names `priority`. `repos/example.json` shows the key as `"priority": null`.
  - **Board read.** With the key set, each tick reads the user-owned Projects board `<owner>/<number>` once, with one `gh api graphql` call per page of 100 items, following `pageInfo.hasNextPage`/`endCursor`. It keeps only the items whose content is an Issue of the config's `repo`. Items from another repo, draft issues, pull requests and null nodes are ignored. An issue's tier is its single-select value in the field: `Urgent`, `High`, `Medium` or `Low`, matched after trimming and ignoring case. An open issue that isn't on the board, has no value, or has any other option (such as `Someday`) has no tier.
- **`tick(cfg, deps)`** (function, changed; `apps/issue-pipeline/src/orchestrator/tick.ts:244`). `tick(cfg: Config, deps: TickDeps): TickResult`, where `TickResult` is `{ decisions, parents, warnings: string[] }`, which also writes `orchestrator.log`. Its tests check these Behaviour items:
  - **Config key.** A repo config may set `priority: { "project": "<owner>/<number>", "field": "<name>" }`. `field` is optional and defaults to `"Priority"`. If `priority` is left out or `null`, a tick reads no board (it makes no `gh api graphql` call), returns `warnings: []`, and every decision and log line is exactly as it is today. That includes new issues, which keep their stage-then-age order with no shuffle. A `priority` key that doesn't match this shape (for example `{ "project": "alice" }`) makes `tick` throw an error whose message names `priority`. `repos/example.json` shows the key as `"priority": null`.
  - **Board read.** With the key set, each tick reads the user-owned Projects board `<owner>/<number>` once, with one `gh api graphql` call per page of 100 items, following `pageInfo.hasNextPage`/`endCursor`. It keeps only the items whose content is an Issue of the config's `repo`. Items from another repo, draft issues, pull requests and null nodes are ignored. An issue's tier is its single-select value in the field: `Urgent`, `High`, `Medium` or `Low`, matched after trimming and ignoring case. An open issue that isn't on the board, has no value, or has any other option (such as `Someday`) has no tier.
  - **Start order.** When the board was read, every start is decided in tier order: Urgent, High, Medium, Low, then no tier. A tier outranks both stage and age. A higher tier takes the free `maxJobs`/stage-cap slots first.
  - **Reasons.** A start whose issue has a tier gets the reason `<reason>:priority-<tier>`, both in its `Decision` and in its `orchestrator.log` line, for example `free:priority-high`, `lifted:priority-high` or `merge-first:priority-low`. A start with no tier keeps the bare `free`, `merge-first` or `lifted`. Held reasons don't change.
  - **Unreadable board.** If the board can't be read, the tick returns exactly one warning in `TickResult.warnings`, naming the board (`<owner>/<number>`), and schedules as if the key were unset (as in item 1, with no tier suffix and no shuffle). This covers gh exiting non-zero (a missing `read:project` scope, a network error), a reply that isn't JSON, and a reply without the board (`projectV2: null`). `orchestrate` writes each warning to stderr as `orchestrate: <warning>`, and the tick goes on.
- **`schedule(snapshot, settings, now)`** (function, changed; `apps/issue-pipeline/src/orchestrator/schedule.ts:255`). `schedule(snapshot: Snapshot, settings: ScheduleSettings, now: Date): Decision[]`; `snapshot` now carries `prioritized` and each issue's `priority`. Its tests check these Behaviour items:
  - **Config key.** A repo config may set `priority: { "project": "<owner>/<number>", "field": "<name>" }`. `field` is optional and defaults to `"Priority"`. If `priority` is left out or `null`, a tick reads no board (it makes no `gh api graphql` call), returns `warnings: []`, and every decision and log line is exactly as it is today. That includes new issues, which keep their stage-then-age order with no shuffle. A `priority` key that doesn't match this shape (for example `{ "project": "alice" }`) makes `tick` throw an error whose message names `priority`. `repos/example.json` shows the key as `"priority": null`.
  - **Start order.** When the board was read, every start is decided in tier order: Urgent, High, Medium, Low, then no tier. A tier outranks both stage and age. A higher tier takes the free `maxJobs`/stage-cap slots first.
  - **Within a tier.** Issues past triage go first, in today's order (later stage first, then older: `byStageThenAge`). Then come the tier's new issues, those whose next job is `triage`, including issues with answered questions. When the board was read this applies to the no-tier group too.
  - **Seeded pick.** The order of a tier's new issues comes from a seed derived from the tick's `now` and each issue's number. `schedule(snapshot, settings, now)` gives the same result for the same snapshot and `now`, so it stays a pure function. Across ticks the order varies: among 5 new issues of one tier, each comes first at some tick within 100 consecutive one-minute ticks.
  - **Nothing preempted, holds stand.** A live job of a lower tier keeps running and gets no decision. The global and stage caps, the rate limit, `after:#M` holds, stacking holds and the `files-overlap:#M` gate apply to every tier unchanged.
  - **Reasons.** A start whose issue has a tier gets the reason `<reason>:priority-<tier>`, both in its `Decision` and in its `orchestrator.log` line, for example `free:priority-high`, `lifted:priority-high` or `merge-first:priority-low`. A start with no tier keeps the bare `free`, `merge-first` or `lifted`. Held reasons don't change.
- **`mergeRank(issues)`** (function, changed; `apps/issue-pipeline/src/orchestrator/queue.ts:239`). `mergeRank(issues: readonly SnapshotIssue[]): number[]` (issue numbers, first to merge first). Its tests check these Behaviour items:
  - **Merge queue.** `mergeRank` ranks the merge-ready issues by tier first (Urgent … none), then by how many waiting issues depend on them, then by lower PR, then by lower issue number. The order is deterministic and does not depend on `now`. `--merge-queue`, the `merge-order:#M` holds and `mergeHolders` all follow this order.
  - **Reasons.** A start whose issue has a tier gets the reason `<reason>:priority-<tier>`, both in its `Decision` and in its `orchestrator.log` line, for example `free:priority-high`, `lifted:priority-high` or `merge-first:priority-low`. A start with no tier keeps the bare `free`, `merge-first` or `lifted`. Held reasons don't change.

## Tests

All tests use `node:test` `.mjs` under `apps/issue-pipeline/test/` and run in `mise //apps/issue-pipeline:check`. Today 12 of them fail on assertions (none on imports or types). Typecheck and lint pass. Every test is deterministic. The "seeded" tests read a pure function at fixed times, so they never flake (`flakes-are-failures`). The tick tests start no process but the fake gh, and spawn returns a dead pid (`pipeline-tests-bounded`).

**`test/orchestrator-priority.test.mjs`** drives `schedule` on recorded snapshots (`snapshotOf(issues, 0, true)` means the board was read):

- *every start goes in tier order, Urgent to none, ahead of stage and age, and names its tier*: items 3 and 8. It fails today because the order is stage-first and the reasons have no suffix.
- *a higher tier takes the free slots and a live job of a lower tier keeps running*: items 3 and 7. It fails today because the stage-first order gives the slot to #11.
- *within a tier the issues past triage go first, by stage then age, then the new ones*: item 4, with an answered issue counted as new. It fails today on order and reasons.
- *a tier's new issues come in an order the tick seeds: the same within a tick, each one first at some tick*: item 5. It fails today because #30 is always first.
- *with a board read, new issues with no priority are seeded too, after every tier*: items 3, 4 and 5. It fails today because #40 isn't first.
- *with no board read, new issues keep their age order at every tick and no start names a tier*: item 1. This guard **passes today**, since it pins "nothing changes".

**`test/orchestrator-priority-merge.test.mjs`** drives `mergeRank` and `schedule`:

- *the merge queue ranks by tier before what each merge unblocks*: items 6 and 8. It fails today because #60, which unblocks #62, ranks first.
- *within a tier the merge queue keeps its order: what it unblocks, then the lower PR, then the number*: item 6. It fails today because the medium #74 (PR 1) ranks ahead of the highs.
- *a higher tier is still held by its after mark and by a live branch that changes its stub*: items 7 and 8. It fails today because the reason has no suffix and the stage order starts #83 instead of #84.

**`test/orchestrator-priority-tick.test.mjs`** drives `tick` and the `priority` key through the world kit and the fake gh (replies matched on `graphql`):

- *a tick orders its starts by the board's tiers, read a page at a time, and logs each start's tier*: items 2, 3, 8 and 9 (`warnings` is `[]`). The test serves 2 pages with an item from another repo, a draft, a null value, a lowercase `low` and an unknown `Someday`. It expects exactly 2 GraphQL calls ("one GraphQL query per tick, paged") and the same reasons in `orchestrator.log`. It fails today because no board is read and the order is stage-first.
- *a board gh can't read gives one warning naming it, and the tick schedules without priority*: item 9. It fails today because `warnings` is `[]`.
- *a board reply the tick can't read gives one warning, and the tick schedules without priority*: item 9, with `projectV2: null` and non-JSON replies. It fails today because `warnings` is `[]`.
- *a malformed priority key fails the tick, naming the key*: item 1. It fails today because the tick ignores the key.
- *with no priority key, or a null one as repos/example.json has, a tick reads no board and warns of nothing*: item 1. This guard **passes today**.

**Fixture changes** (already committed): `orchestrator-fixtures.mjs` (`priority: null` in BLANK; `snapshotOf(issues, spent, prioritized)`), `orchestrator-priority-fixtures.mjs` (shared helpers), and `orchestrator-snapshot.test.mjs` / `orchestrator-snapshot-stubs.test.mjs` (the new fields). Existing assertions are unchanged, because unconfigured reasons keep their format.

**Untested glue.** `orchestrate.ts`'s stderr line (item 9's last sentence) and the README text (Design) are a thin adapter and docs. No test drives `orchestrate.ts`'s loop today.

## Wiki updates

- **Running-the-Issue-Pipeline.md**:
  - "Set up a repo" step 2: the token needs `read:project` for `priority`, and the fine-grained token caveat.
  - Orchestrator: `priority` in the config keys, a new **Priority** paragraph (how to set a priority on the board, the key, the read, the order rules, the fallback warning and the malformed key), the "What runs" order sentence, the merge-ranking bullet (tier first), and "The log" (`:priority-<tier>` suffix).
- **Issue-Pipeline.md**: new decision `### priority-first`, with what it chose and what it rejected.
- **Pipeline-Roles-Orchestrator.md**: the "Fetch and iterate" order bullet.

## Assumptions and risks

- **Token scope.** GitHub's docs name `read:project` on a classic PAT or a GitHub App installation token for the Projects API, and say nothing of fine-grained tokens. A repo using a fine-grained `tokenFile` may get the item 9 warning on every tick. The wiki says so.
- **User-owned boards only**, as the issue settled. An org board (`organization(login)`) gives `projectV2: null` under `user(login)` and so falls back with a warning.
- **Wire shape.** The GraphQL shape comes from GitHub's public schema (`ProjectV2Item.content: ProjectV2ItemContent = DraftIssue | Issue | PullRequest`, `fieldValueByName(name:)`, `ProjectV2ItemFieldSingleSelectValue.name: String`, `items(first, after)`). gh exits non-zero on a GraphQL error reply.
- **Board size.** A large board costs one call per 100 items each tick, which is fine at this repo's size. A board with thousands of items would make each tick slower.
- **Hash spread.** The seeded test needs a hash that spreads consecutive minutes well. A weak hash (such as summing char codes) may fail it. The test is deterministic, so a failure there is a real defect, not a flake.
- **Line limits.** These force the new `tiers.ts` and a trim in `tick.ts`/`snapshot.ts`.
- **Null key.** The `null` form of the key is my choice, so the example file can list it without turning it on. The issue's "Without it, nothing changes" covers it.

## Sources

- Issue #393 and its triage notes; the handoff from the previous spec-writer session.
- `AGENTS.md`, `CONTRIBUTING.md`; wiki Decisions-Code-and-tooling (`tests-pin-promised-behaviour`, `flakes-are-failures`, `pipeline-tests-bounded`), Decisions.md.
- Wiki Running-the-Issue-Pipeline ("Set up a repo", "Orchestrator"), Issue-Pipeline (`merge-order`, `no-file-lists`, `orchestrator-closes-parents`, `stage-jobs-replace-lanes`), Pipeline-Roles-Orchestrator.
- `apps/issue-pipeline/src/orchestrator/{queue,schedule,snapshot,tick,log,priority}.ts`, `src/github.ts:14,34,95`, `src/orchestrate.ts:116`, `src/config-schema.ts:61`, `repos/example.json`, `README.md:16,46`; `test/orchestrator-tick.test.mjs`, `test/orchestrator-world-test-kit.mjs`, `test/fake-gh.mjs`, `test/orchestrator-fixtures.mjs`.
- https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects (scopes, `user(login){projectV2(number)}`).
- https://raw.githubusercontent.com/octokit/graphql-schema/main/schema.graphql (ProjectV2Item, ProjectV2ItemContent, ProjectV2ItemFieldSingleSelectValue, ProjectV2 `items`).

<!-- end of spec -->
