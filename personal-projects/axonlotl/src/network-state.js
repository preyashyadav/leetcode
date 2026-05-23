/**
 * Axonlotl Network State (core "brain" data structure).
 * This module owns the mutable singleton state for the runtime.
 */

/**
 * @typedef {"healthy"|"degraded"|"critical"|"dead"} AgentStatus
 */

/**
 * @typedef {object} AgentState
 * @property {number} health
 * @property {AgentStatus} status
 * @property {string[]} capabilities
 * @property {number} tasksCompleted
 * @property {number} tasksFailed
 * @property {number} avgResponseTime
 */

/**
 * @typedef {object} CoverageEdge
 * @property {"planner"|"coder"|"reviewer"|"tester"|"deployer"} agent
 * @property {number} coverage
 * @property {number} latencyMultiplier
 */

/**
 * @typedef {object} NetworkStateShape
 * @property {{planner: AgentState, coder: AgentState, reviewer: AgentState, tester: AgentState, deployer: AgentState}} agents
 * @property {{planner: CoverageEdge[], coder: CoverageEdge[], reviewer: CoverageEdge[], tester: CoverageEdge[], deployer: CoverageEdge[]}} capabilityMap
 * @property {("planner"|"coder"|"reviewer"|"tester"|"deployer")[]} pipeline
 * @property {Record<string, number>} routeWeights
 * @property {number} reliabilityScore
 * @property {number} intentDeviationScore
 * @property {Array<object>} eventLog
 */

function clone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/**
 * Compute agent status string based on health rules.
 * @param {number} health
 * @returns {AgentStatus}
 */
export function computeStatusFromHealth(health) {
  if (health === 0) return "dead";
  if (health < 0.3) return "critical";
  if (health <= 0.7) return "degraded";
  return "healthy";
}

/**
 * @returns {NetworkStateShape}
 */
function createInitialState() {
  return {
    agents: {
      planner: {
        health: 1.0,
        status: "healthy",
        capabilities: ["planning", "task_decomposition", "partial_review"],
        tasksCompleted: 0,
        tasksFailed: 0,
        avgResponseTime: 0
      },
      coder: {
        health: 1.0,
        status: "healthy",
        capabilities: ["coding", "debugging", "partial_testing"],
        tasksCompleted: 0,
        tasksFailed: 0,
        avgResponseTime: 0
      },
      reviewer: {
        health: 1.0,
        status: "healthy",
        capabilities: ["code_review", "security_audit", "style_check"],
        tasksCompleted: 0,
        tasksFailed: 0,
        avgResponseTime: 0
      },
      tester: {
        health: 1.0,
        status: "healthy",
        capabilities: ["testing", "qa", "partial_review"],
        tasksCompleted: 0,
        tasksFailed: 0,
        avgResponseTime: 0
      },
      deployer: {
        health: 1.0,
        status: "healthy",
        capabilities: ["deployment", "monitoring", "rollback"],
        tasksCompleted: 0,
        tasksFailed: 0,
        avgResponseTime: 0
      }
    },

    capabilityMap: {
      reviewer: [
        { agent: "tester", coverage: 0.6, latencyMultiplier: 1.8 },
        { agent: "planner", coverage: 0.3, latencyMultiplier: 2.5 }
      ],
      tester: [
        { agent: "reviewer", coverage: 0.4, latencyMultiplier: 2.0 },
        { agent: "coder", coverage: 0.3, latencyMultiplier: 2.2 }
      ],
      coder: [{ agent: "planner", coverage: 0.5, latencyMultiplier: 1.5 }],
      planner: [{ agent: "coder", coverage: 0.4, latencyMultiplier: 2.0 }],
      deployer: [{ agent: "tester", coverage: 0.3, latencyMultiplier: 2.5 }]
    },

    pipeline: ["planner", "coder", "reviewer", "tester", "deployer"],
    routeWeights: {},

    reliabilityScore: 1.0,
    intentDeviationScore: 0.0,

    eventLog: []
  };
}

/** @type {NetworkStateShape} */
let state = createInitialState();

/**
 * Get the current network state (mutable singleton).
 * @returns {NetworkStateShape}
 */
export function getState() {
  return state;
}

/**
 * Get an agent's health score.
 * @param {"planner"|"coder"|"reviewer"|"tester"|"deployer"} agentName
 * @returns {number}
 */
export function getAgentHealth(agentName) {
  const agent = state.agents[agentName];
  if (!agent) throw new Error(`Unknown agent: ${agentName}`);
  return agent.health;
}

/**
 * Adjust an agent's health by delta, clamp to [0, 1], and update status.
 * @param {"planner"|"coder"|"reviewer"|"tester"|"deployer"} agentName
 * @param {number} delta
 * @returns {number} new health
 */
export function updateAgentHealth(agentName, delta) {
  const agent = state.agents[agentName];
  if (!agent) throw new Error(`Unknown agent: ${agentName}`);

  const nextHealth = Math.max(0, Math.min(1, agent.health + delta));
  agent.health = nextHealth;
  agent.status = computeStatusFromHealth(nextHealth);
  return nextHealth;
}

/**
 * Push a timestamped event to the event log.
 * @param {object|string} event
 * @returns {void}
 */
export function logEvent(event) {
  const entry =
    typeof event === "string"
      ? { timestamp: new Date().toISOString(), type: event }
      : { timestamp: new Date().toISOString(), ...event };

  state.eventLog.push(entry);
}

/**
 * Reset network state to initial healthy defaults.
 * @returns {void}
 */
export function resetState() {
  state = clone(createInitialState());
}

/**
 * Reset to a known-good baseline for demos:
 * - all agents health=1.0, status="healthy"
 * - all routeWeights set to 0.5 (or initialized if missing)
 * - clears event log
 * @returns {NetworkStateShape}
 */
export function resetNetwork() {
  const next = createInitialState();

  for (const name of Object.keys(next.agents)) {
    next.agents[name].health = 1.0;
    next.agents[name].status = "healthy";
  }

  // Normalize routeWeights to 0.5 for every known edge; keep shape compatible.
  const defaults = {
    "reviewer→tester": { weight: 0.5, successes: 0, failures: 0 },
    "reviewer→planner": { weight: 0.5, successes: 0, failures: 0 },
    "tester→reviewer": { weight: 0.5, successes: 0, failures: 0 },
    "tester→coder": { weight: 0.5, successes: 0, failures: 0 },
    "coder→planner": { weight: 0.5, successes: 0, failures: 0 },
    "planner→coder": { weight: 0.5, successes: 0, failures: 0 },
    "deployer→tester": { weight: 0.5, successes: 0, failures: 0 }
  };
  next.routeWeights = defaults;

  next.eventLog = [];
  state = clone(next);
  return state;
}
