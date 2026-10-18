import { JobState, TERMINAL_STATES } from "@sideagent/protocol";
import { describe, expect, it } from "vitest";
import { canTransition } from "../src/jobs/transitions.ts";

/** Every edge a pipeline step or the API writes. Anything else must be refused. */
const EDGES: readonly (readonly [JobState, JobState])[] = [
  ["draft", "screening"],
  ["screening", "test_review"],
  ["screening", "rejected"],
  ["test_review", "open"],
  ["test_review", "rejected"],
  ["open", "claimed"],
  ["claimed", "running"],
  ["claimed", "submitted"],
  ["claimed", "open"],
  ["running", "submitted"],
  ["running", "open"],
  ["submitted", "checking"],
  ["checking", "passed"],
  ["checking", "failed"],
  ["passed", "released"],
  ["failed", "claimed"],
  ["failed", "open"],
];

describe("job transitions", () => {
  it("allows exactly the edges the service writes", () => {
    const allowed = new Set(EDGES.map(([from, to]) => `${from}->${to}`));
    for (const from of JobState.options) {
      for (const to of JobState.options) {
        expect(canTransition(from, to), `${from} → ${to}`).toBe(allowed.has(`${from}->${to}`));
      }
    }
  });

  it("refuses a draft that skips the checkpoint", () => {
    expect(canTransition("draft", "open")).toBe(false);
    expect(canTransition("draft", "released")).toBe(false);
    expect(canTransition("screening", "open")).toBe(false);
  });

  it("treats states with no outgoing edge as terminal, including the reserved ones", () => {
    const sinks = JobState.options.filter((from) =>
      JobState.options.every((to) => !canTransition(from, to)),
    );
    expect(sinks.sort()).toEqual([...TERMINAL_STATES].sort());
  });
});
