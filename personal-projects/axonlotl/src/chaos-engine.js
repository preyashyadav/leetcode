/**
 * Injects faults and calculates resilience metrics.
 */

import { getState, computeStatusFromHealth } from "./network-state.js";
import { runPipeline } from "./orchestrator.js";

function clone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function restoreInto(target, snapshot) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, clone(snapshot));
}

/**
 * injectChaos(agentName, faultType)
 * @param {"planner"|"coder"|"reviewer"|"tester"|"deployer"} agentName
 * @param {"kill"|"degrade"|"hallucinate"|"slow"} faultType
 * @returns {any} updated network state
 */
export function injectChaos(agentName, faultType) {
  const state = getState();
  const agent = state.agents[agentName];
  if (!agent) throw new Error(`Unknown agent: ${agentName}`);

  if (faultType === "kill") agent.health = 0.0;
  else if (faultType === "degrade") agent.health = 0.2;
  else if (faultType === "hallucinate") agent.health = 0.4;
  else if (faultType === "slow") agent.health = 0.6;
  else throw new Error(`Unknown faultType: ${faultType}`);

  agent.status = computeStatusFromHealth(agent.health);
  return state;
}

/**
 * healAgent(agentName)
 * @param {"planner"|"coder"|"reviewer"|"tester"|"deployer"} agentName
 * @returns {any}
 */
export function healAgent(agentName) {
  const state = getState();
  const agent = state.agents[agentName];
  if (!agent) throw new Error(`Unknown agent: ${agentName}`);
  agent.health = 1.0;
  agent.status = "healthy";
  return state;
}

/**
 * healAll()
 * @returns {any}
 */
export function healAll() {
  const state = getState();
  for (const name of Object.keys(state.agents)) healAgent(name);
  return state;
}

/**
 * Calculate reliability score from pipeline results.
 * Formula: (0.4 * Avg_Quality) + (0.4 * (1 - Avg_Drift)) + (0.2 * Success_Rate)
 * @param {Array<any>} results
 * @returns {number} between 0.0 and 1.0
 */
export function calculateReliability(results) {
  const list = Array.isArray(results) ? results : [];
  if (list.length === 0) return 0;

  const drifts = list.map((r) => Number(r?.drift?.drift_score ?? r?.drift_score ?? 0));
  const avgDrift = drifts.reduce((a, b) => a + b, 0) / drifts.length;
  const hasBadDrift = drifts.some((d) => Number.isFinite(d) && d > 0.5);

  const qualities = list.map((r, idx) => {
    const drift = drifts[idx];
    const success = Boolean(r?.success ?? r?.passed ?? true);
    const q = Math.max(0, Math.min(1, 1 - (Number.isFinite(drift) ? drift : 0)));
    return success ? q : 0;
  });
  const avgQuality = qualities.reduce((a, b) => a + b, 0) / qualities.length;

  const successRate =
    list.filter((r) => Boolean(r?.success ?? r?.passed ?? false)).length / list.length;

  const score = 0.4 * avgQuality + 0.4 * (1 - avgDrift) + 0.2 * successRate;
  const clamped = Math.max(0, Math.min(1, score));
  // Demo requirement: any semantic drift > 0.5 caps reliability to 0.50 (danger zone).
  return hasBadDrift ? Math.min(0.5, clamped) : clamped;
}

function keywords(text) {
  const stop = new Set([
    "a","an","the","and","or","but","to","of","in","on","for","with","as","at","by",
    "from","is","are","was","were","be","been","being","it","this","that","these",
    "those","i","you","we","they","he","she","them","us","our","your","my","me",
    "do","does","did","done","will","would","can","could","should","may","might",
    "build","create","make","implement","write","simple"
  ]);
  return new Set(
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !stop.has(w))
  );
}

/**
 * Intent deviation: compare original intent to final output summary using keyword overlap.
 * If final is <20% related, spike I_dev above 0.4.
 * @param {string} originalIntent
 * @param {string} finalSummary
 * @returns {number} 0.0-1.0
 */
export function calculateIntentDeviation(originalIntent, finalSummary) {
  const intent = String(originalIntent ?? "");
  const summary = String(finalSummary ?? "");
  if (!intent.trim() || !summary.trim()) return 1.0;

  const a = keywords(intent);
  const b = keywords(summary);
  if (a.size === 0 || b.size === 0) return 1.0;

  let overlap = 0;
  for (const w of b) if (a.has(w)) overlap += 1;
  const overlapRatio = overlap / b.size; // "how related is output to intent"

  // Only use length-mismatch as a strong signal when the intent itself is sizable/complex.
  const lengthMismatch =
    intent.length > 200 && summary.length < Math.max(80, Math.floor(intent.length * 0.2));

  if (overlapRatio < 0.2 || lengthMismatch) return 0.6;
  if (overlapRatio < 0.35) return 0.4;
  return Math.max(0, Math.min(0.4, 0.4 - overlapRatio * 0.2));
}

function pickFinalSummaryFromResults(results) {
  const last = Array.isArray(results) && results.length ? results[results.length - 1] : null;
  if (!last) return "";
  if (typeof last?.output === "string") return last.output;
  if (typeof last?.raw === "string") return last.raw;
  try {
    return JSON.stringify(last?.output ?? last, null, 2);
  } catch {
    return String(last?.output ?? last);
  }
}

/**
 * Shadow Mode: clone state, inject a hallucination fault, run a mini-pipeline, report predicted R.
 * @param {unknown} task
 * @param {(event:any)=>void} eventCallback
 * @param {number} miniSteps how many pipeline steps to run (default 2)
 * @returns {Promise<{agent:string, fault:string, predictedR:number, predictedI_dev:number, results:any[]}>}
 */
export async function runShadowTest(task, eventCallback = () => {}, miniSteps = 2, faultType = "hallucinate") {
  const state = getState();
  const snapshot = clone(state);

  const agentNames = /** @type {("planner"|"coder"|"reviewer"|"tester"|"deployer")[]} */ (
    Object.keys(state.agents)
  );
  const agent = agentNames[Math.floor(Math.random() * agentNames.length)];

  injectChaos(agent, faultType);
  try {
    eventCallback({ type: "shadow_injected", agent, fault: faultType });
  } catch {
    // ignore
  }

  const originalPipeline = [...state.pipeline];
  state.pipeline = originalPipeline.slice(0, Math.max(1, Math.min(originalPipeline.length, miniSteps)));

  const run = await runPipeline(task, eventCallback);
  const predictedR = calculateReliability(run.results);
  const finalSummary = pickFinalSummaryFromResults(run.results);
  const predictedI_dev = calculateIntentDeviation(String(task ?? ""), finalSummary);

  restoreInto(state, snapshot);

  return {
    agent,
    fault: faultType,
    predictedR,
    predictedI_dev,
    results: run.results
  };
}

/**
 * AutoPatch: if R < 0.7 or I_dev > 0.4, heal weakest agent and rewire capabilityMap priority.
 * Rewire lasts 5 minutes (stored on state as metadata).
 * @param {number} R
 * @param {number} I_dev
 * @param {(event:any)=>void} eventCallback
 * @returns {{patched:boolean, weakest?:string, rewired?:boolean, until?:string}}
 */
export function autoPatch(R, I_dev, eventCallback = () => {}) {
  const needs = Number(R) < 0.7 || Number(I_dev) > 0.4;
  if (!needs) return { patched: false };

  const state = getState();
  const entries = Object.entries(state.agents);
  entries.sort((a, b) => Number(a[1]?.health ?? 0) - Number(b[1]?.health ?? 0));
  const weakest = entries[0]?.[0];
  if (!weakest) return { patched: false };

  // Clear faults/caches (in this MVP we treat that as "heal to full").
  healAgent(/** @type {any} */ (weakest));

  // Rewire: rotate capabilityMap ordering so next fallback differs.
  const list = state.capabilityMap?.[weakest];
  let rewired = false;
  if (Array.isArray(list) && list.length >= 2) {
    const original = clone(list);
    const rotated = [...list.slice(1), list[0]];
    state.capabilityMap[weakest] = rotated;
    state._rewire = {
      agent: weakest,
      original,
      until: Date.now() + 5 * 60 * 1000
    };
    rewired = true;
  }

  const until = state._rewire?.until ? new Date(state._rewire.until).toISOString() : undefined;
  try {
    eventCallback({ type: "auto_patch", weakest, rewired, until });
  } catch {
    // ignore
  }

  return { patched: true, weakest, rewired, until };
}

/**
 * runChaosSimulation(task, eventCallback)
 * 1) Save state
 * 2) Run pipeline with random faults injected
 * 3) Calculate R and I_dev
 * 4) Alert if weak
 * 5) Restore original state
 * @param {unknown} task
 * @param {(event:any)=>void} eventCallback
 * @returns {Promise<any>}
 */
export async function runChaosSimulation(task, eventCallback = () => {}) {
  const state = getState();
  const snapshot = clone(state);

  const agentNames = /** @type {("planner"|"coder"|"reviewer"|"tester"|"deployer")[]} */ (
    Object.keys(state.agents)
  );
  const faults = /** @type {("kill"|"degrade"|"hallucinate"|"slow")[]} */ ([
    "kill",
    "degrade",
    "hallucinate",
    "slow"
  ]);

  // Inject 1–2 random faults
  const numFaults = Math.random() < 0.5 ? 1 : 2;
  for (let i = 0; i < numFaults; i++) {
    const agent = agentNames[Math.floor(Math.random() * agentNames.length)];
    const fault = faults[Math.floor(Math.random() * faults.length)];
    injectChaos(agent, fault);
    try {
      eventCallback({ type: "chaos_injected", agent, fault });
    } catch {
      // ignore
    }
  }

  const run = await runPipeline(task, eventCallback);
  const R = calculateReliability(run.results);
  const finalSummary = pickFinalSummaryFromResults(run.results);
  const I_dev = calculateIntentDeviation(String(task ?? ""), finalSummary);

  const result = {
    ...run,
    R,
    I_dev
  };

  if (R < 0.8 || I_dev > 0.4) {
    result.alert = true;
    result.recommendation =
      "System shows weakness under chaos; increase coverage redundancy, tune reroute weights, and tighten drift detection thresholds.";
  } else {
    result.alert = false;
  }

  restoreInto(state, snapshot);
  return result;
}
