/**
 * Proportional load reduction by health.
 */

/**
 * Reduce workload proportionally as health drops.
 * (Kept for later; orchestrator uses `classifyHealth` for now.)
 * @param {object} _args
 * @returns {{loadFactor: number, actions: object}}
 */
export function computeDegradationPlan(_args) {
  throw new Error("computeDegradationPlan not implemented");
}

/**
 * Classify an agent's operating mode by health.
 * @param {number} health
 * @returns {"normal"|"degraded"|"skip"}
 */
export function classifyHealth(health) {
  // Demo requirements:
  // - killed/lesioned: health < 0.1 => MUST skip and reroute
  // - degraded: 0.1–0.7 => degraded mode
  if (health > 0.7) return "normal";
  if (health >= 0.1) return "degraded";
  return "skip";
}
