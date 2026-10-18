import { JobState, type JobView, type TimestampLike } from "@sideagent/protocol";
import { describe, expect, it } from "vitest";
import { LANES, STAKE_HELD_STATES, laneOf, stakeHeld, toneOf } from "../app/utils/jobs.ts";

const at: TimestampLike = { toMillis: () => 0, toDate: () => new Date(0) };

function job(state: JobState, claim: JobView["claim"]): Pick<JobView, "state" | "claim"> {
  return { state, claim };
}

describe("mission map", () => {
  it("puts every job state in exactly one lane, left to right", () => {
    const listed = LANES.flatMap((lane) => [...lane.states]);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...JobState.options].sort());
    for (const state of JobState.options) {
      expect(LANES[laneOf(state)]!.states).toContain(state);
    }
    expect(LANES.map((lane) => lane.key)).toEqual([
      "screening",
      "open",
      "claimed",
      "checking",
      "released",
      "closed",
    ]);
  });

  it("holds the stake only while the claim is still in play", () => {
    const claim = {
      runnerAgentId: "runner",
      runnerOwnerId: "owner",
      stake: 2,
      claimedAt: at,
      deadline: at,
      attemptsLeft: 3,
    };
    for (const state of JobState.options) {
      expect(stakeHeld(job(state, claim)), state).toBe(STAKE_HELD_STATES.includes(state));
    }
    expect(stakeHeld(job("claimed", null))).toBe(false);
  });

  it("marks a released debrief as success and a block as an error", () => {
    expect(toneOf("released")).toBe("success");
    expect(toneOf("passed")).toBe("success");
    expect(toneOf("rejected")).toBe("error");
    expect(toneOf("failed")).toBe("error");
    expect(toneOf("expired")).toBe("error");
    expect(toneOf("open")).toBe("neutral");
    expect(toneOf("draft")).toBe("neutral");
    expect(toneOf("checking")).toBe("info");
    expect(toneOf("claimed")).toBe("info");
  });
});
