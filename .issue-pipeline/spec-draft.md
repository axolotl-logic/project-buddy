## Behaviour

Paths are relative to `apps/web/`. Items 5-9 describe `inFlightLimit(limit)` in `src/test-database/in-flight-limit.ts`. Items 10-14 describe the server-test setup, `vitest.server-setup.ts`.

1. **One named bound.** `src/test-database/request-bound.ts` exports `TEST_DATABASE_MAX_IN_FLIGHT` (8), with a comment saying that it stays under the test database's Neon proxy pool per endpoint (8 in the pipeline's per-issue proxy), because the proxy answers HTTP 500 "Too many connections to this endpoint" to a request beyond that pool instead of queueing it.
2. **Shares derived from the bound.** The same file derives `SERVER_TEST_WORKERS` and `REQUESTS_PER_WORKER = Math.floor(TEST_DATABASE_MAX_IN_FLIGHT / SERVER_TEST_WORKERS)` from it, so one edit changes both; `REQUESTS_PER_WORKER` is at least 1, and the file imports nothing.
3. **A fixed worker count.** The server project's `test.maxWorkers` in `vitest.server.config.mts` is the number `SERVER_TEST_WORKERS`, whatever the machine's core count.
4. **Within the bound across workers.** `SERVER_TEST_WORKERS × REQUESTS_PER_WORKER ≤ TEST_DATABASE_MAX_IN_FLIGHT`.
5. **Under the limit, work starts at once.** While fewer than `limit` pieces of work are in flight, the function that `inFlightLimit(limit)` returns starts new work at once, in the same call.
6. **Beyond the limit, work waits.** Work beyond the limit waits, so never more than `limit` pieces run at once; it starts when an earlier piece ends, by the time the ended piece's promise settles, with no timer.
7. **First in, first out.** Held work starts in the order it was given.
8. **Failures free their slot.** Work that rejects runs once, with no retry, and frees its slot, and the returned promise rejects with the same error.
9. **Results pass through.** The returned promise settles with what the work returns.
10. **Every server test worker stays within its share.** In every server test, the Neon HTTP driver's requests go through one `inFlightLimit(REQUESTS_PER_WORKER)` per worker, which covers everything `getDb()` sends, the kit's cleanup included.
11. **Parallel queries wait and succeed.** A server test that starts more queries at once than `REQUESTS_PER_WORKER` waits for a free slot, and all of its queries succeed.
12. **Counted until the reply is read.** At most `REQUESTS_PER_WORKER` of a worker's driver requests are in flight at the global `fetch` at once, counted from when each is sent until its reply's body has been read.
13. **A stubbed fetch still sees the driver.** The limited request calls whatever the global `fetch` is when it is sent, so a server test that stubs `fetch` (`src/manual/update-manual.server.test.ts:87`) still sees both the driver's requests and its own fetches.
14. **Other fetches are not limited.** Fetches made other than through the Neon driver are not limited: the global `fetch` itself is left unwrapped.
15. **Documented for later parts.** The server-test section of `apps/web/AGENTS.md` (lines 10-16) has a bullet saying that the bound is `TEST_DATABASE_MAX_IN_FLIGHT` in `src/test-database/request-bound.ts`, that the worker count and the per-worker limit derive from it, that the setup file applies the limit to every test database request over HTTP, and that later parts of the e2e migration (#341) must not raise the bound, send test database requests around the limit, or retry on the proxy's 500.
16. **The checks pass.** `npm run check` and `npm run test:server` pass.

## Out of scope

- Production code (`src/db/client.ts` and everything under `src/` except `src/test-database/`), `vitest.config.mts`, `npm test`, and the `dev` and `build` scripts stay unchanged. Only the server tests' setup and config change.
- The WebSocket pools from `openPool` (`src/db/keep-data-through-update.server.test.ts:150`, `src/manual/update-manual.server.test.ts:112` and the reindex in `src/manual/reindex-manual.ts:18`) stay outside the HTTP limit. See Assumptions and risks.
- The Playwright e2e suite, its worker count (`playwright.config.ts`) and the unit and browser projects in `vitest.config.mts`.
- `compose.test-db.yml` and the proxy's own settings.
- Retrying on the proxy's 500, in tests or in production.
- A `--maxWorkers` passed on the command line, which overrides the config. Nothing in the repo passes one.
- Reproducing load on the pipeline machine.

## Design

**Approach.** Three parts, all under the server-test project:

1. **`src/test-database/request-bound.ts`** (new, committed with its final values). It has no imports, so `vitest.server.config.mts` can import it with a relative `.ts` path, as the setup file imports `./scripts/test-db/test-database.ts`. It holds `TEST_DATABASE_MAX_IN_FLIGHT = 8`, `SERVER_TEST_WORKERS = 4` and the derived `REQUESTS_PER_WORKER` (2). The implementer may keep or rephrase its comments. Four workers with 2 requests each keeps some parallelism across files, where module loading dominates, and within a file's `Promise.all`.
2. **`src/test-database/in-flight-limit.ts`** (new; the stub throws). `inFlightLimit(limit: number): InFlightLimit`, where `type InFlightLimit = <T>(work: () => Promise<T>) => Promise<T>`. Keep a count and a FIFO queue of waiters. On release, hand the slot straight to the next waiter, or else decrement. Release in `finally`, so a rejection frees the slot. It has no timers and no retry. It is general-purpose and knows nothing of Neon.
3. **Wiring.**
   - In `vitest.server.config.mts:22-29`, add `maxWorkers: SERVER_TEST_WORKERS` to `test`, imported from `./src/test-database/request-bound.ts`. Vitest 5.0.3 names the option `maxWorkers?: number | string` (`node_modules/vitest/dist/chunks/plugin.d.BsjqSb4-.d.ts:3634`). `fileParallelism` can only lower it, to 1 (same file, :3637), so the number of files in flight never exceeds `maxWorkers`.
   - In `vitest.server-setup.ts`, after `checkTestEnvironment()` at :14, set `neonConfig.fetchFunction` once (`@neondatabase/serverless`). Set it to a function that runs each request through one `inFlightLimit(REQUESTS_PER_WORKER)`. Inside the slot, the function calls the global `fetch` (looked up at call time, never captured at install or chained to a previous `fetchFunction`), reads the reply's body in full and returns `new Response(body, reply)`. The slot is then held until the proxy has sent the whole reply.
   - The installed `@neondatabase/serverless` 1.2.0 reads `neonConfig.fetchFunction` on every query, not when `neon()` is called: `index.mjs:1301` destructures `fetchFunction` from the global config inside the query function, and `index.mjs:1311` calls `(D??fetch)(…)`. So setting it in the setup file covers the client `getDb()` (`src/db/client.ts:75`) already made, and clients that `vi.resetModules` makes again (`src/db/storage-down-test-kit.ts`).
   - The setup file runs before each test file in its worker, and a worker runs one file at a time. So each worker has one limiter at a time, and setting the field again replaces the wrapper rather than stacking a second one.
   - The global `fetch` stays unwrapped, so git's stubbed `fetch` in `update-manual.server.test.ts:87` is not limited.
   - Write the wrapper in the setup file, or in a small kit module beside it if the setup file would pass 300 lines. Don't change `src/db/client.ts`.
4. **`apps/web/AGENTS.md`.** Add the bullet in Behaviour 15 to the server-test list, after "Keep server tests fast" (:16).

**Design it twice** (CONTRIBUTING, Design).

- *Chosen:* a fixed worker count and an in-flight limit per worker, both derived from one constant. Each piece is local and has no timers.
- *Rejected:* one limit that every worker shares. Vitest's forked workers share no memory, so it would need a broker process or a lock file, and much more machinery.
- *Rejected:* a worker cap alone, which doesn't bound one test's `Promise.all` (the issue's Design).
- *Rejected:* `maxWorkers: 1` with a limit of 8, which runs the files one at a time.
- *Rejected:* wrapping `globalThis.fetch` for the database host. It isn't needed, since the driver reads `fetchFunction` per query, and a test's own `vi.stubGlobal("fetch", …)` would replace it.
- *Rejected:* retrying on the 500 (the issue's Design, `flakes-are-failures`).

**Practices followed.**

- CONTRIBUTING Design: a deep, general-purpose limiter; information hiding, since the bound lives once, in `request-bound.ts`, and only the setup file knows about Neon's `fetchFunction`; comments that say what a module promises.
- Types: explicit parameter and return types, no `any`, `!` or `as`, and `import type` for the limiter's type.
- Lint: imports name `.ts`, exports come last, named constants (`noMagicNumbers`), 300 and 50 line limits.
- Tests: test-first and no timing (`flakes-are-failures`). A server test is a `*.server.test.ts` under `npm run test:server`, and the unit tests run under `npm test`.
- Wiki: `web-tests-under-load` and `e2e-test-database-speed` (the proxy and the HTTP driver stay; the WebSocket `Pool` for tests stays rejected); `use-cases-drive-tests` and `e2e-visual-and-auth-only` (server tests).
- The new decision `test-database-request-bound` (written by this spec) records the choice.

## Test interfaces

- `inFlightLimit(limit)`, a function in `src/test-database/in-flight-limit.ts` (new): Behaviour 5-9.
- `TEST_DATABASE_MAX_IN_FLIGHT`, `SERVER_TEST_WORKERS` and `REQUESTS_PER_WORKER`, config constants in `src/test-database/request-bound.ts` (new): Behaviour 1, 2 and 4.
- The server Vitest config, the default export of `vitest.server.config.mts` (changed): `test.maxWorkers`, Behaviour 3 and 4.
- The server-test setup, `vitest.server-setup.ts`, a module (changed), driven through `getDb()` in a server test: Behaviour 10-14.
- The server-test guidance in `apps/web/AGENTS.md:10-16` (changed): Behaviour 15, checked by review.
- `npm run check` and `npm run test:server`, the repo's scripts (existing): Behaviour 16, run at acceptance.

## Tests

All three files fail today because the behaviour is missing, not because of an import, syntax or type error. Biome and `tsc` pass on them.

- **`src/test-database/in-flight-limit.test.ts`** (new; unit project, `// @vitest-environment node`, runs in `npm test` and `npm run check`). It drives `inFlightLimit`, using held work that the test resolves or rejects itself, with no timers. Today every test fails with the stub's "inFlightLimit is not implemented yet (#399)" error. All five pass against a reference limiter (tried locally, then removed).
  - "starts work at once while under the limit": Behaviour 5.
  - "holds work beyond the limit until earlier work ends": Behaviour 6, with N + 1 calls, peak equal to N, and the extra call started by the time the first one's promise settles (a limiter that started it on a timer would fail this check).
  - "starts held work in the order it was given": Behaviour 7.
  - "runs work that fails once, frees its slot, and passes its error on": Behaviour 8, with the failed work's run count at 1.
  - "returns what each piece of work returns": Behaviour 9.
- **`vitest.server.config.test.ts`** (extended; unit project). It drives the server config's default export and the constants.
  - "run in a fixed number of workers, whatever the machine": Behaviour 3. It fails today with `expected undefined to be 4`.
  - "stay within the test database's limit across every worker": Behaviour 4, `maxWorkers × REQUESTS_PER_WORKER ≤ TEST_DATABASE_MAX_IN_FLIGHT`. It fails today because `maxWorkers` is not a number.
  - "leave each worker at least one request in flight": Behaviour 2. It guards the derived constant against a deadlock and passes on the stub, because the stub holds the constants' final values. Behaviour 1's comment and Behaviour 2's derivation and import-free file are checked by review.
- **`src/test-database/request-bound.server.test.ts`** (new; server project, `npm run test:server`). It drives the setup file through `getDb()`.
  - "a test's queries started together wait for a free request slot": Behaviour 10, 11, 12 and 13. It stubs the global `fetch` with a counter around the real one, counting each request until its reply's body is read, and runs `3 × REQUESTS_PER_WORKER` `select 1` queries at once through `getDb()`. Every query must succeed (11), all of them must reach the stubbed global `fetch` (13), and the peak in flight must be at most `REQUESTS_PER_WORKER` (10, 12).
  - It fails today with `expected 6 to be less than or equal to 2`. It was run against a reset test database of its own.
  - With a reference limiter and wiring, it passed together with `src/test-database/` and `update-manual.server.test.ts` (13 tests), and was then removed.
- **Behaviour 14 is checked by review, with no test of its own.** A test that stubs the global `fetch` replaces any wrapper the setup put there, so it can't see one. A test against a real local server needs `node:http`, which Biome's `noNodejsModules` forbids in `src/` outside its listed overrides (`apps/web/biome.jsonc:259-297`). `update-manual.server.test.ts` keeps covering that a stubbed `fetch` serves git's requests. Review checks that the setup sets `neonConfig.fetchFunction` and leaves `globalThis.fetch` alone.
- Behaviour 15 is checked by review, and Behaviour 16 by running `npm run check` and `npm run test:server` once at acceptance. There is no load reproduction (the issue's Tests).

## Wiki updates

- `Decisions-Code-and-tooling.md`: the new decision `test-database-request-bound`, giving the bound, where it lives, the derivation, the wiring through `neonConfig.fetchFunction`, the WebSocket pools left outside it, and what was rejected.
- `Decisions.md`: index entry for `test-database-request-bound`.

## Assumptions and risks

- **The proxy's limit of 8.** The issue gives the per-issue proxy's pool of 8. The error text matches Neon's proxy (`TooManyConnections`, https://github.com/neondatabase/neon/blob/8f60b04d/proxy/src/auth/mod.rs). The pool is per endpoint (https://github.com/neondatabase/neon/blob/8f60b04d/proxy/src/serverless/conn_pool_lib.rs). The repo itself doesn't state the 8.
- **WebSocket pools.** `openPool`'s WebSocket connections, used by two scratch-database tests and the reindex they run, are not counted. Whether the proxy counts them against the same endpoint limit is unverified. Bounding them would mean changing production `openPool` or `reindexManual`, which the Out of scope list rules out (production code stays unchanged). They are recorded in the wiki decision as outside the limit. If they turn out to trip the 500, a follow-up can lower `SERVER_TEST_WORKERS` to leave headroom, or give the scratch tests a smaller pool.
- **Suite time.** The suite may take longer with 4 workers instead of cores − 1. Each test's own queries queue only within its worker, so the 40 000 ms `SERVER_TEST_TIMEOUT_MS` still covers a test (`web-tests-under-load`).
- **CLI override.** A `--maxWorkers` flag on the command line would override the config. No script passes one.
- **Other proxies.** Several pipeline lanes may each run a suite against the shared proxy on port 4444. The bound is per suite, as the issue scopes it, and the per-issue proxies are separate.
- **Reading the body inside the slot.** The wrapper reads each reply's body inside the slot and rebuilds the `Response`. The driver then reads `ok`, `status` and `json()` (`index.mjs:1311` onward), which a rebuilt `Response` keeps.
- **Pre-existing type errors.** `tsc --noEmit` in a checkout without `next typegen` reports the existing `PageProps`/`LayoutProps` errors. They are unrelated to this change, and `npm run typecheck` in a full install is the check.

## Sources

- Repo:
  - `AGENTS.md`, `CONTRIBUTING.md`, `apps/web/AGENTS.md:10-16`
  - `apps/web/vitest.server.config.mts:18-30`, `apps/web/vitest.server.config.test.ts`, `apps/web/vitest.server-setup.ts:7-44`
  - `apps/web/src/db/client.ts:74-76`
  - `apps/web/src/manual/update-manual.server.test.ts:80-112`, `apps/web/src/db/keep-data-through-update.server.test.ts:145-150`, `apps/web/src/manual/reindex-manual.ts:18`
  - `apps/web/compose.test-db.yml`, `apps/web/.env.test.example`
- Installed packages:
  - `node_modules/@neondatabase/serverless/index.mjs:1301,1311` and `index.d.ts:671-678` (1.2.0)
  - `node_modules/vitest/dist/chunks/plugin.d.BsjqSb4-.d.ts:3631-3641` (5.0.3)
- Wiki: `Decisions-Code-and-tooling` (`web-tests-under-load`, `e2e-test-database-speed`, `flakes-are-failures`, `use-cases-drive-tests`, `e2e-visual-and-auth-only`, `tests-pin-promised-behaviour`), `Decisions`, `Home`.
- Web:
  - https://github.com/neondatabase/neon/blob/8f60b04d/proxy/src/auth/mod.rs
  - https://github.com/neondatabase/neon/blob/8f60b04d/proxy/src/serverless/conn_pool_lib.rs
- Issue #399 and its triage notes.

<!-- end of spec -->
