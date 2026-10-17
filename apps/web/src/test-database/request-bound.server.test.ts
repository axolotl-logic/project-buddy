import { sql } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { getDb } from "@/db/client.ts";
import { REQUESTS_PER_WORKER } from "@/test-database/request-bound.ts";

// How many times a worker's share of requests the test starts together.
const SHARES = 3;

// More queries than a worker may have in flight, started together.
const QUERIES: number = REQUESTS_PER_WORKER * SHARES;

// The requests that reached the global fetch, and the most of them that were
// in flight at once.
interface RequestCounts {
  sent: number;
  peak: number;
}

// Counts the requests that reach the global fetch, and the most of them in
// flight at once, from when each is sent until its reply's body is read.
function countRequests(): RequestCounts {
  const send = globalThis.fetch;
  const counts: RequestCounts = { sent: 0, peak: 0 };
  let inFlight = 0;
  vi.stubGlobal(
    "fetch",
    async (...request: Parameters<typeof fetch>): Promise<Response> => {
      counts.sent += 1;
      inFlight += 1;
      counts.peak = Math.max(counts.peak, inFlight);
      try {
        const reply = await send(...request);
        return new Response(await reply.arrayBuffer(), reply);
      } finally {
        inFlight -= 1;
      }
    },
  );
  return counts;
}

test("a test's queries started together wait for a free request slot", async () => {
  const requests = countRequests();
  try {
    const answers = await Promise.all(
      Array.from({ length: QUERIES }, () => getDb().execute(sql`select 1`)),
    );

    expect(answers).toHaveLength(QUERIES);
    expect(requests.sent).toBe(QUERIES);
    expect(requests.peak).toBeLessThanOrEqual(REQUESTS_PER_WORKER);
  } finally {
    vi.unstubAllGlobals();
  }
});
