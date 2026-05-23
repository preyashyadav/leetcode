/**
 * HealthMonitor: updates agent health based on middleware drift results
 * and provides system-level reliability / intent deviation metrics.
 */

import { getState, updateAgentHealth, logEvent } from "./network-state.js";

/**
 * Update agent health based on middlewareResult + responseTime.
 * @param {"planner"|"coder"|"reviewer"|"tester"|"deployer"} agentName
 * @param {{drift_score?: number, passed?: boolean}} middlewareResult
 * @param {number} responseTime
 * @returns {{agent: string, prevHealth: number, newHealth: number, delta: number}}
 */
export function updateHealthFromResult(agentName, middlewareResult, responseTime, options = {}) {
  const state = getState();
  const agent = state.agents[agentName];
  if (!agent) throw new Error(`Unknown agent: ${agentName}`);

  const drift = Number(middlewareResult?.drift_score ?? 0);
  const prevHealth = agent.health;

  let delta = 0;

  if (drift < 0.2 && responseTime < 10_000) delta += 0.05;
  else if (drift >= 0.2 && drift < 0.5) delta -= 0.1;
  else if (drift >= 0.5 && drift <= 0.8) delta -= 0.25;
  else if (drift > 0.8) delta -= 0.5;

  if (responseTime > 30_000) delta -= 0.2;

  // Cover-mode penalty: don't allow the covering agent to be "killed" immediately.
  // Floor the resulting health at 0.1 so it can complete the task under stability penalty.
  if (options?.coverMode === true) {
    const projected = Math.max(0, Math.min(1, prevHealth + delta));
    if (projected < 0.1) delta = 0.1 - prevHealth;
  }

  const newHealth = updateAgentHealth(agentName, delta);

  logEvent({
    type: "health_update",
    agent: agentName,
    prevHealth,
    newHealth,
    delta: newHealth - prevHealth,
    drift_score: drift,
    passed: Boolean(middlewareResult?.passed),
    responseTime
  });

  state.reliabilityScore = getSystemReliability(state);
  state.intentDeviationScore = getIntentDeviation(state);

  return { agent: agentName, prevHealth, newHealth, delta: newHealth - prevHealth };
}

/**
 * Calculate overall system reliability R.
 * Weighted average of health by pipeline position importance.
 * planner & deployer weight 1.0; others weight 1.5.
 * @param {any} networkState
 * @returns {number}
 */
export function getSystemReliability(networkState) {
  const pipeline = networkState?.pipeline ?? [];
  const agents = networkState?.agents ?? {};

  const weights = {
    planner: 1.0,
    coder: 1.5,
    reviewer: 1.5,
    tester: 1.5,
    deployer: 1.0
  };

  let weightedSum = 0;
  let weightTotal = 0;

  for (const name of pipeline) {
    const agent = agents[name];
    if (!agent) continue;
    const w = weights[name] ?? 1.0;
    weightedSum += Number(agent.health ?? 0) * w;
    weightTotal += w;
  }

  if (weightTotal === 0) return 0;
  return weightedSum / weightTotal;
}

/**
 * Calculate intent deviation I_dev as the average drift_score across last 10 events.
 * Only considers events that have a numeric drift_score.
 * @param {any} networkState
 * @returns {number}
 */
export function getIntentDeviation(networkState) {
  const events = Array.isArray(networkState?.eventLog) ? networkState.eventLog : [];
  const last10 = events.slice(-10);
  const drifts = last10
    .map((e) => e?.drift_score)
    .filter((d) => typeof d === "number" && Number.isFinite(d));

  if (drifts.length === 0) return 0;
  return drifts.reduce((a, b) => a + b, 0) / drifts.length;
}
