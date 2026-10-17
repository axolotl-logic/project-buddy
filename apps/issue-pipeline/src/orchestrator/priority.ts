// The repo's issue priorities (#393): the config's optional `priority` key,
// `{ project: "<owner>/<number>", field?: "Priority" }`, names a Projects
// board owned by a user, and each open issue's tier is the option its
// single-select field holds there. Stub: the spec for #393 describes it.

import type { Config } from "../config.ts";
import type { Tier } from "./queue.ts";

// The board's tiers: off with no `priority` key; read, by issue number of
// the config's repo; or unread, with the one warning that says why.
type Priorities =
  | { kind: "off" }
  | { kind: "read"; tiers: ReadonlyMap<number, Tier> }
  | { kind: "unread"; warning: string };

function readPriorities(cfg: Config): Priorities {
  throw new Error(`readPriorities(${cfg.repo}) is not implemented (#393)`);
}

export type { Priorities };
export { readPriorities };
