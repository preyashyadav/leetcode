/**
 * RouteEngine: chooses alternative agents when one fails.
 * Uses `capabilityMap` from `networkState`.
 */

/**
 * Find the best alternative for a failed agent.
 * @param {"planner"|"coder"|"reviewer"|"tester"|"deployer"} failedAgent
 * @param {any} networkState
 * @returns {{agent: string, coverage: number, latencyMultiplier: number} | null}
 */
export function findAlternative(failedAgent, networkState) {
  const alternatives = networkState?.capabilityMap?.[failedAgent];
  if (!Array.isArray(alternatives) || alternatives.length === 0) return null;

  const viable = alternatives.filter((alt) => {
    const health = networkState?.agents?.[alt.agent]?.health;
    return typeof health === "number" && health > 0.3;
  });

  if (viable.length === 0) return null;

  const weights = networkState?.routeWeights ?? {};

  const ranked = [...viable].sort((a, b) => {
    const byCoverage = (b.coverage ?? 0) - (a.coverage ?? 0);
    if (byCoverage !== 0) return byCoverage;

    const aKey = `${failedAgent}→${a.agent}`;
    const bKey = `${failedAgent}→${b.agent}`;
    const aWeight = Number(weights?.[aKey]?.weight ?? weights?.[aKey] ?? 0);
    const bWeight = Number(weights?.[bKey]?.weight ?? weights?.[bKey] ?? 0);
    return bWeight - aWeight;
  });

  const best = ranked[0];
  return best
    ? {
        agent: best.agent,
        coverage: Number(best.coverage ?? 0),
        latencyMultiplier: Number(best.latencyMultiplier ?? 1)
      }
    : null;
}

/**
 * Build a rerouted pipeline by replacing failedAgent with a cover-mode step.
 * Example:
 *  failedAgent="reviewer", alternative.agent="tester" =>
 *  replace "reviewer" with "tester_as_reviewer"
 * @param {string[]} originalPipeline
 * @param {"planner"|"coder"|"reviewer"|"tester"|"deployer"} failedAgent
 * @param {{agent: string}} alternative
 * @returns {string[]}
 */
export function buildReroutedPipeline(originalPipeline, failedAgent, alternative) {
  const coverStep = `${alternative.agent}_as_${failedAgent}`;
  return originalPipeline.map((step) => (step === failedAgent ? coverStep : step));
}

