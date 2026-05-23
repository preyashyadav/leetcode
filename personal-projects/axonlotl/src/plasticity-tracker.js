/**
 * PlasticityTracker: records reroute outcomes and maintains route weights.
 * Stored on `networkState.routeWeights` as a map keyed by "A→B".
 */

/**
 * Record a reroute outcome and update its weight.
 * @param {"planner"|"coder"|"reviewer"|"tester"|"deployer"} originalAgent
 * @param {"planner"|"coder"|"reviewer"|"tester"|"deployer"} alternativeAgent
 * @param {boolean} success
 * @param {number} quality
 * @param {any} networkState
 * @returns {{key: string, weight: number, successes: number, failures: number}}
 */
export function recordReroute(
  originalAgent,
  alternativeAgent,
  success,
  quality,
  networkState
) {
  const key = `${originalAgent}→${alternativeAgent}`;
  const store = (networkState.routeWeights ??= {});

  const current = store[key] ?? { weight: 0.5, successes: 0, failures: 0 };
  const entry = {
    weight: Number(current.weight ?? 0.5),
    successes: Number(current.successes ?? 0),
    failures: Number(current.failures ?? 0)
  };

  void quality; // reserved for later weighting refinements

  if (success) {
    entry.weight = Math.min(2.0, entry.weight + 0.2);
    entry.successes += 1;
  } else {
    entry.weight = Math.max(0.1, entry.weight - 0.3);
    entry.failures += 1;
  }

  store[key] = entry;
  return { key, ...entry };
}

/**
 * Choose the best alternative based on coverage × route_weight, filtered by health > 0.3.
 * Falls back to pure coverage ranking if no weight history exists.
 * @param {"planner"|"coder"|"reviewer"|"tester"|"deployer"} failedAgent
 * @param {{agent: string, coverage: number, latencyMultiplier: number}[]} alternatives
 * @param {any} networkState
 * @returns {{agent: string, coverage: number, latencyMultiplier: number} | null}
 */
export function getBestAlternative(failedAgent, alternatives, networkState) {
  const viable = (alternatives ?? []).filter((alt) => {
    const health = networkState?.agents?.[alt.agent]?.health;
    return typeof health === "number" && health > 0.3;
  });
  if (viable.length === 0) return null;

  const store = networkState?.routeWeights ?? {};
  const withScores = viable.map((alt) => {
    const key = `${failedAgent}→${alt.agent}`;
    const w = store?.[key]?.weight ?? store?.[key];
    const weight = typeof w === "number" ? w : Number(w ?? NaN);
    const hasHistory = Number.isFinite(weight);
    return {
      alt,
      hasHistory,
      score: hasHistory ? Number(alt.coverage ?? 0) * weight : Number(alt.coverage ?? 0)
    };
  });

  const anyHistory = withScores.some((x) => x.hasHistory);
  const ranked = [...withScores].sort((a, b) => b.score - a.score);
  const best = ranked[0]?.alt ?? null;

  if (!anyHistory) {
    return [...viable].sort((a, b) => (b.coverage ?? 0) - (a.coverage ?? 0))[0] ?? null;
  }

  return best;
}

/**
 * Return all recorded route weights for dashboard display.
 * @param {any} networkState
 * @returns {Record<string, {weight:number, successes:number, failures:number}>}
 */
export function getRouteWeights(networkState) {
  return networkState?.routeWeights ?? {};
}

