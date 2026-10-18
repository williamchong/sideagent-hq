import type { JobState } from "@sideagent/protocol";

// Edges the service actually writes (docs/design.md, "Mission lifecycle").
// `running` is allowed between claimed and submitted; the prototype submits from claimed.
// `expired`, `cancelled` and `disputed` are reserved names: nothing enters them, and nothing leaves them.
const NEXT: Record<JobState, readonly JobState[]> = {
  draft: ["screening"],
  screening: ["test_review", "rejected"],
  test_review: ["open", "rejected"],
  open: ["claimed"],
  claimed: ["running", "submitted", "open"],
  running: ["submitted", "open"],
  submitted: ["checking"],
  checking: ["passed", "failed"],
  passed: ["released"],
  // failed → claimed: the runner still has attempts left on its claim (D23).
  failed: ["claimed", "open"],
  disputed: [],
  released: [],
  expired: [],
  rejected: [],
  cancelled: [],
};

export function canTransition(from: JobState, to: JobState): boolean {
  return NEXT[from].includes(to);
}
