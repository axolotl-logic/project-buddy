// @vitest-environment node
import { describe, expect, test } from "vitest";
import { type InFlightLimit, inFlightLimit } from "./in-flight-limit.ts";

const LIMIT = 2;

// A limit of one, under which work runs one piece at a time.
const ONE_AT_A_TIME = 1;

// Three pieces of work under ONE_AT_A_TIME: one running and two held.
const ONE_RUNNING_TWO_HELD = 3;

// One piece of work that runs until the test ends it.
interface HeldWork {
  // Whether the limit has started the work.
  readonly started: () => boolean;
  // How many times the limit has run the work.
  readonly runs: () => number;
  // What the limit returned for the work.
  readonly done: Promise<string>;
  readonly finish: (value: string) => void;
  readonly fail: (error: Error) => void;
}

// Gives work to limit that runs until the test finishes or fails it, and
// counts how many pieces run at once.
function holdWork(
  limit: InFlightLimit,
  count: number,
): { readonly works: HeldWork[]; readonly peak: () => number } {
  let inFlight = 0;
  let peak = 0;
  const works = Array.from({ length: count }, (): HeldWork => {
    let started = false;
    const calls = { runs: 0 };
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const done = limit(async (): Promise<string> => {
      started = true;
      calls.runs += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        return await promise;
      } finally {
        inFlight -= 1;
      }
    });
    return {
      started: (): boolean => started,
      runs: (): number => calls.runs,
      done,
      finish: resolve,
      fail: reject,
    };
  });
  return { works, peak: (): number => peak };
}

// The piece of work at index, which the test made.
function workAt(works: readonly HeldWork[], index: number): HeldWork {
  const work = works[index];
  if (work === undefined) {
    throw new Error(`no work at ${index}`);
  }
  return work;
}

describe("an in-flight limit", () => {
  test("starts work at once while under the limit", () => {
    const { works } = holdWork(inFlightLimit(LIMIT), LIMIT);

    expect(works.map((work) => work.started())).toStrictEqual([true, true]);
  });

  test("holds work beyond the limit until earlier work ends", async () => {
    const { works, peak } = holdWork(inFlightLimit(LIMIT), LIMIT + 1);

    expect(workAt(works, LIMIT).started()).toBe(false);

    workAt(works, 0).finish("first");
    await expect(workAt(works, 0).done).resolves.toBe("first");

    expect(workAt(works, LIMIT).started()).toBe(true);
    expect(peak()).toBe(LIMIT);
  });

  test("starts held work in the order it was given", async () => {
    const { works } = holdWork(
      inFlightLimit(ONE_AT_A_TIME),
      ONE_RUNNING_TWO_HELD,
    );

    workAt(works, 0).finish("first");
    await workAt(works, 0).done;

    expect(works.map((work) => work.started())).toStrictEqual([
      true,
      true,
      false,
    ]);
  });

  test("runs work that fails once, frees its slot, and passes its error on", async () => {
    const { works } = holdWork(inFlightLimit(ONE_AT_A_TIME), ONE_AT_A_TIME + 1);
    const error = new Error("refused");

    workAt(works, 0).fail(error);

    await expect(workAt(works, 0).done).rejects.toBe(error);
    expect(workAt(works, 0).runs()).toBe(1);
    expect(workAt(works, 1).started()).toBe(true);
  });

  test("returns what each piece of work returns", async () => {
    const { works } = holdWork(inFlightLimit(LIMIT), LIMIT + 1);

    for (const [index, work] of works.entries()) {
      work.finish(`work ${index}`);
    }

    await expect(
      Promise.all(works.map((work) => work.done)),
    ).resolves.toStrictEqual(["work 0", "work 1", "work 2"]);
  });
});
