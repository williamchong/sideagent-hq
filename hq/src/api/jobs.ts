import { JobType, PostJobInput, SubmitResultInput } from "@sideagent/protocol";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "../auth.ts";
import { parseInput, readJson } from "../errors.ts";
import type { JobService } from "../jobs/service.ts";

const MAX_WAIT_SECONDS = 30;

const typesCsv = z
  .string()
  .optional()
  .transform((s) => (s ? s.split(",") : undefined))
  .pipe(z.array(JobType).optional());

const ListQuery = z.object({
  types: typesCsv,
  min_reward: z.coerce.number().int().nonnegative().optional(),
});

// Opt-in filter for the dev command executor (D18): only jobs posted by the caller's owner.
const sameOwnerFlag = z
  .enum(["true", "false"])
  .optional()
  .transform((s) => s === "true");

const NextQuery = z.object({
  types: typesCsv,
  same_owner: sameOwnerFlag,
  wait: z.coerce.number().int().min(0).max(MAX_WAIT_SECONDS).default(MAX_WAIT_SECONDS),
});

const ClaimQuery = z.object({ same_owner: sameOwnerFlag });

/** `/v1` REST routes. Same service calls as the MCP tools. */
export function jobRoutes(jobs: JobService) {
  return new Hono<AuthEnv>()
    .post("/jobs", async (c) => {
      const input = parseInput(PostJobInput, await readJson(c.req.raw));
      return c.json(await jobs.postJob(c.var.agent, input));
    })
    .get("/jobs", async (c) => {
      return c.json(await jobs.listJobs(c.var.agent, parseInput(ListQuery, c.req.query())));
    })
    .get("/jobs/:id", async (c) => c.json(await jobs.getStatus(c.var.agent, c.req.param("id"))))
    .post("/jobs/:id/claim", async (c) => {
      const { same_owner } = parseInput(ClaimQuery, c.req.query());
      return c.json(await jobs.claimJob(c.var.agent, c.req.param("id"), { sameOwner: same_owner }));
    })
    .post("/jobs/:id/submissions", async (c) => {
      const body = await readJson(c.req.raw);
      const input = parseInput(SubmitResultInput, {
        ...(body as object),
        job_id: c.req.param("id"),
      });
      return c.json(await jobs.submitResult(c.var.agent, input));
    })
    .get("/balance", async (c) => c.json(await jobs.getBalance(c.var.agent)))
    .get("/runner/next", async (c) => {
      const { types, wait, same_owner } = parseInput(NextQuery, c.req.query());
      const job = await jobs.nextJob(
        c.var.agent,
        { types, sameOwner: same_owner },
        wait * 1000,
        c.req.raw.signal,
      );
      return job ? c.json(job) : c.body(null, 204);
    });
}
