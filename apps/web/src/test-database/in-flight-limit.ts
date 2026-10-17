// Runs async work with at most a fixed number of pieces in flight at once.

// Runs work as soon as fewer than the limit are in flight, or else once
// earlier work ends, in the order it was given, and settles as work does.
type InFlightLimit = <T>(work: () => Promise<T>) => Promise<T>;

// A limit of `limit` pieces of work in flight at once, for a whole number
// limit of at least 1.
function inFlightLimit(_limit: number): InFlightLimit {
  throw new Error("inFlightLimit is not implemented yet (#399)");
}

export type { InFlightLimit };
export { inFlightLimit };
