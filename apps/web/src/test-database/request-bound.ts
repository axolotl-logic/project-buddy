// How many requests the server tests (vitest.server.config.mts) may have in
// flight at the test database at once, and how they share it out. It has no
// imports, so the Vitest config can import it as well as the kit.

// The test database's Neon proxy keeps a fixed pool of connections per
// endpoint, 8 in the issue pipeline's proxy, and answers HTTP 500 "Too many
// connections to this endpoint" to a request beyond it rather than queueing
// it (#399). The server tests stay at or under it, so a busy machine fails no
// test (flakes-are-failures). Don't raise it, and don't send test database
// requests around the limit.
const TEST_DATABASE_MAX_IN_FLIGHT = 8;

// The most test files the server tests run at once, each in its own worker.
const SERVER_TEST_WORKERS = 4;

// The most test database requests one worker has in flight at once: its
// share of TEST_DATABASE_MAX_IN_FLIGHT.
const REQUESTS_PER_WORKER: number = Math.floor(
  TEST_DATABASE_MAX_IN_FLIGHT / SERVER_TEST_WORKERS,
);

export {
  REQUESTS_PER_WORKER,
  SERVER_TEST_WORKERS,
  TEST_DATABASE_MAX_IN_FLIGHT,
};
