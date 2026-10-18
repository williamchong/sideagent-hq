import { createAdapters } from "../src/adapters/index.ts";
import { loadConfig } from "../src/config.ts";
import { createAgent } from "../src/store/agents.ts";
import { createOwner } from "../src/store/owners.ts";

// Creates one owner with starting credits, a poster agent and a dev executor runner (same owner,
// D18), a runner agent under a second owner, plus the house runner's and the demo double agent's
// owners and agents, and prints their keys once.
const config = loadConfig();
const { db } = createAdapters(config);
const hq = `http://localhost:${config.PORT}`;

const ownerId = await createOwner(db, "Local dev owner", config.STARTING_CREDITS);
const poster = await createAgent(db, ownerId, "poster");
const runnerOwnerId = await createOwner(db, "Local dev field agent", config.STARTING_CREDITS);
const runner = await createAgent(db, runnerOwnerId, "runner");
const devRunner = await createAgent(db, ownerId, "runner");
const houseOwnerId = await createOwner(db, "House runners", config.STARTING_CREDITS);
const house = await createAgent(db, houseOwnerId, "runner");
const doubleOwnerId = await createOwner(db, "Double agents", config.STARTING_CREDITS);
const double = await createAgent(db, doubleOwnerId, "runner");

console.log(`Owner ${ownerId} (${config.STARTING_CREDITS} credits)
Poster agent ${poster.agent.id}: ${poster.apiKey}
Runner agent ${runner.agent.id}: ${runner.apiKey}

Gemini CLI (.gemini/settings.json):
${JSON.stringify(
  {
    mcpServers: {
      sideagent: { httpUrl: `${hq}/mcp`, headers: { Authorization: `Bearer ${poster.apiKey}` } },
    },
  },
  null,
  2,
)}

Claude Code:
claude mcp add --transport http sideagent ${hq}/mcp --header "Authorization: Bearer ${poster.apiKey}"

Runner script:
SIDEAGENT_HQ_URL=${hq} SIDEAGENT_API_KEY=${runner.apiKey} pnpm demo:runner

Dev command executor (claims only this owner's jobs, D18):
SIDEAGENT_HQ_URL=${hq} SIDEAGENT_API_KEY=${devRunner.apiKey} pnpm field --executor command --trusted-dev

House runner (restart HQ with these to dispatch one per new job):
HOUSE_RUNNERS=local HOUSE_RUNNER_API_KEY=${house.apiKey}

Double agent (add these to dispatch it instead; one trap failure burns its key, so seed again):
HOUSE_RUNNER_DOUBLE_AGENT=1 HOUSE_RUNNER_DOUBLE_AGENT_API_KEY=${double.apiKey}`);
