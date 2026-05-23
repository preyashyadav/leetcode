/**
 * Orchestrator: runs the multi-agent pipeline with Axonlotl self-healing.
 */

import { getState, logEvent } from "./network-state.js";
import { before_agent, modify_request, after_agent } from "./middleware-interceptor.js";
import { updateHealthFromResult, getSystemReliability, getIntentDeviation } from "./health-monitor.js";
import { runWorkerAgent, runWorkerAgentInCoverMode } from "./worker-agents.js";
import { classifyHealth } from "./degradation-manager.js";
import { findAlternative } from "./route-engine.js";
import { recordReroute } from "./plasticity-tracker.js";

function noop() {}

function humanizeCapability(cap) {
  const map = {
    code_review: "Code Verification",
    security_audit: "Security Audit",
    style_check: "Style Check",
    testing: "Testing",
    qa: "QA",
    partial_review: "Code Verification",
    coding: "Implementation",
    debugging: "Debugging",
    partial_testing: "Testing",
    planning: "Planning",
    task_decomposition: "Task Decomposition",
    deployment: "Deployment",
    monitoring: "Monitoring",
    rollback: "Rollback"
  };
  return map[cap] ?? cap;
}

function overlapReason(state, failedAgent, alternativeAgent, coverage) {
  const failedCaps = state?.agents?.[failedAgent]?.capabilities ?? [];
  const altCaps = state?.agents?.[alternativeAgent]?.capabilities ?? [];
  const intersection = failedCaps.filter((c) => altCaps.includes(c));
  const domains = [...new Set(intersection.map(humanizeCapability))].slice(0, 3);
  const pct = Math.round(Number(coverage ?? 0) * 100);
  const domText = domains.length ? domains.map((d) => `'${d}'`).join(" and ") : "critical adjacent skillsets";
  return {
    pct,
    domains,
    text: `${alternativeAgent} is taking over for ${failedAgent}. Reason: ${alternativeAgent} possesses ${pct}% semantic overlap in ${domText}.`
  };
}

/**
 * Emit event to dashboard + store in network event log.
 * @param {(e: any) => void} eventCallback
 * @param {any} event
 */
function emit(eventCallback, event) {
  try {
    eventCallback(event);
  } catch {
    // swallow
  }
  try {
    logEvent(event);
  } catch {
    // swallow
  }
}

function unwrapCoverStep(step) {
  const m = String(step).match(/^(\w+)_as_(\w+)$/);
  if (!m) return null;
  return { coveringRole: m[1], originalRole: m[2] };
}

/**
 * Run the full pipeline with self-healing.
 * @param {unknown} task
 * @param {(event: any) => void} eventCallback
 * @returns {Promise<{results: any[], networkState: any, R: number, I_dev: number}>}
 */
export async function runPipeline(task, eventCallback = noop) {
  const state = getState();
  const results = [];
  let currentInput = task;
  const degradedSteps = new Set();
  let failedAt = null;
  let completedSteps = 0;
  let prevAgent = null;
  let rerouteCount = 0;

  for (const step of state.pipeline) {
    const cover = unwrapCoverStep(step);
    const agentName = cover?.originalRole ?? step;

    const agent = state.agents[agentName];
    const health = Number(agent?.health ?? 0);

    // 1) before_agent
    const pre = before_agent(agentName, currentInput, state);
    if (pre.blocked) {
      emit(eventCallback, { type: "agent_blocked", agent: agentName, reason: pre.reason });
      // proceed to rerouting attempt
    }

    const mode = classifyHealth(health);

    if (pre.blocked || mode === "skip") {
      emit(eventCallback, { type: "agent_skipped", agent: agentName, health });

      const alternative = findAlternative(agentName, state);
      if (!alternative) {
        emit(eventCallback, { type: "no_alternative", agent: agentName });
        failedAt = agentName;
        break;
      }

      emit(eventCallback, {
        type: "reroute",
        from: prevAgent,
        failedAgent: agentName,
        to: alternative.agent,
        coverage: alternative.coverage,
        overlap: overlapReason(state, agentName, alternative.agent, alternative.coverage)
      });
      rerouteCount += 1;

      const coverResult = await runWorkerAgentInCoverMode(agentName, alternative.agent, pre.modified_input || currentInput);
      const drift = after_agent(alternative.agent, pre.modified_input || currentInput, coverResult, state);
      updateHealthFromResult(alternative.agent, drift, coverResult.responseTime ?? 0, { coverMode: true });

      const quality = 1 - drift.drift_score;
      const routeRecord = recordReroute(agentName, alternative.agent, drift.passed, quality, state);

      emit(eventCallback, {
        type: "reroute_complete",
        success: Boolean(drift.passed),
        quality,
        route: routeRecord,
        routeWeights: state.routeWeights
      });

      results.push({
        step: `${alternative.agent}_as_${agentName}`,
        agent: coverResult.agent,
        ...coverResult,
        drift
      });
      currentInput = coverResult.success ? coverResult.output : coverResult;
      completedSteps += 1;
      prevAgent = alternative.agent;
      continue;
    }

    // 2) degradation mode modifies request
    let inputToUse = pre.modified_input;
    if (mode === "degraded") {
      degradedSteps.add(agentName);
      inputToUse = modify_request(agentName, inputToUse, state).modified_input;
    }

    // 3) run agent
    const result = cover
      ? await runWorkerAgentInCoverMode(cover.originalRole, cover.coveringRole, inputToUse)
      : await runWorkerAgent(agentName, inputToUse);

    // 4) after_agent drift
    const drift = after_agent(agentName, inputToUse, result, state);

    // 5) health update
    updateHealthFromResult(agentName, drift, result.responseTime ?? 0);

    // 6) event
    emit(eventCallback, {
      type: "agent_fire",
      agent: agentName,
      health: state.agents[agentName].health,
      success: Boolean(result.success),
      driftScore: drift.drift_score
    });

    // 7) drift failure => reroute
    if (drift.drift_score > 0.5) {
      emit(eventCallback, { type: "drift_detected", agent: agentName, score: drift.drift_score });
      const alternative = findAlternative(agentName, state);
      if (alternative) {
        emit(eventCallback, {
          type: "reroute",
          from: prevAgent,
          failedAgent: agentName,
          to: alternative.agent,
          coverage: alternative.coverage,
          overlap: overlapReason(state, agentName, alternative.agent, alternative.coverage)
        });
        rerouteCount += 1;

        const coverResult = await runWorkerAgentInCoverMode(agentName, alternative.agent, inputToUse);
        const coverDrift = after_agent(alternative.agent, inputToUse, coverResult, state);
        updateHealthFromResult(alternative.agent, coverDrift, coverResult.responseTime ?? 0, { coverMode: true });

        const quality = 1 - coverDrift.drift_score;
        const routeRecord = recordReroute(agentName, alternative.agent, coverDrift.passed, quality, state);

        emit(eventCallback, {
          type: "reroute_complete",
          success: Boolean(coverDrift.passed),
          quality,
          route: routeRecord,
          routeWeights: state.routeWeights
        });

        results.push({ step: agentName, agent: result.agent, ...result, drift });
        results.push({
          step: `${alternative.agent}_as_${agentName}`,
          agent: coverResult.agent,
          ...coverResult,
          drift: coverDrift
        });

        currentInput = coverResult.success ? coverResult.output : coverResult;
        completedSteps += 1;
        prevAgent = alternative.agent;
        continue;
      }

      emit(eventCallback, { type: "no_alternative", agent: agentName });
      results.push({ step: agentName, agent: result.agent, ...result, drift });
      failedAt = agentName;
      break;
    }

    results.push({ step: agentName, agent: result.agent, ...result, drift });
    currentInput = result.success ? result.output : result;
    completedSteps += 1;
    prevAgent = agentName;
  }

  const R = getSystemReliability(state);
  const I_dev = getIntentDeviation(state);
  const success = failedAt == null && completedSteps === state.pipeline.length;
  const degradedStepsArr = [...degradedSteps];

  emit(eventCallback, {
    type: "pipeline_complete",
    results,
    R,
    I_dev,
    success,
    degradedSteps: degradedStepsArr,
    failedAt,
    routeWeights: state.routeWeights,
    rerouteCount
  });
  return {
    results,
    networkState: state,
    R,
    I_dev,
    success,
    degradedSteps: degradedStepsArr,
    failedAt,
    rerouteCount
  };
}

// Alias for the prompt wording.
export const runPipelineWithHealing = runPipeline;

/**
 * Run the pipeline without self-healing (for before/after demo).
 * If any agent fails, the pipeline crashes.
 * @param {unknown} task
 * @param {(event: any) => void} eventCallback
 * @returns {Promise<{results: any[], crashed: boolean, crashedAt?: string}>}
 */
export async function runPipelineWithoutHealing(task, eventCallback = noop) {
  const state = getState();
  const results = [];
  let currentInput = task;

  for (const agentName of state.pipeline) {
    emit(eventCallback, { type: "agent_fire", agent: agentName, health: state.agents[agentName].health });
    const result = await runWorkerAgent(agentName, currentInput);
    results.push(result);

    if (!result.success) {
      emit(eventCallback, { type: "pipeline_crashed", crashedAt: agentName });
      return { results, crashed: true, crashedAt: agentName };
    }

    currentInput = result.output;
  }

  emit(eventCallback, { type: "pipeline_complete", results, crashed: false });
  return { results, crashed: false };
}
