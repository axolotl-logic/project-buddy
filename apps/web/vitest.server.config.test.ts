// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  REQUESTS_PER_WORKER,
  SERVER_TEST_WORKERS,
  TEST_DATABASE_MAX_IN_FLIGHT,
} from "./src/test-database/request-bound.ts";
import serverConfig from "./vitest.server.config.mts";

// Vitest's own limits for a test and a hook in Node, which the server tests'
// database work can pass on a busy machine
// (https://vitest.dev/config/testtimeout, https://vitest.dev/config/hooktimeout).
const VITEST_TEST_TIMEOUT_MS = 5000;
const VITEST_HOOK_TIMEOUT_MS = 10_000;

describe("server test timeouts", () => {
  test("a server test may run longer than Vitest's default", () => {
    expect(serverConfig.test?.testTimeout).toBeGreaterThan(
      VITEST_TEST_TIMEOUT_MS,
    );
  });

  test("a server test's hooks may run longer than Vitest's default", () => {
    expect(serverConfig.test?.hookTimeout).toBeGreaterThan(
      VITEST_HOOK_TIMEOUT_MS,
    );
  });
});

describe("server test database requests", () => {
  test("run in a fixed number of workers, whatever the machine", () => {
    expect(serverConfig.test?.maxWorkers).toBe(SERVER_TEST_WORKERS);
  });

  test("stay within the test database's limit across every worker", () => {
    const workers = serverConfig.test?.maxWorkers;
    if (typeof workers !== "number") {
      throw new Error("the server tests' worker count is not a number");
    }

    expect(workers * REQUESTS_PER_WORKER).toBeLessThanOrEqual(
      TEST_DATABASE_MAX_IN_FLIGHT,
    );
  });

  test("leave each worker at least one request in flight", () => {
    expect(REQUESTS_PER_WORKER).toBeGreaterThanOrEqual(1);
  });
});
