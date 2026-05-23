import { getState, resetState, updateAgentHealth, logEvent } from "./network-state.js";
import { injectChaos, healAll } from "./chaos-engine.js";
import { runPipeline } from "./orchestrator.js";
import { toggleMockMode, setMockScenario } from "./worker-agents.js";

/**
 * Pre-cached JSON responses for demo mode.
 * These allow Axonlotl to keep the WebSocket event flow identical even if Gemini is rate-limited.
 */
export const DEMO_CACHE = {
  planner: {
    subtasks: [
      "Define requirements and threat model",
      "Implement secure login route",
      "Add input validation and rate limiting",
      "Add password hashing and safe error handling",
      "Add tests and documentation"
    ],
    analysis: "Focus on security: hashing, timing-safe comparisons, session/token strategy, and validation."
  },
  coder: {
    language: "javascript",
    files: ["src/server.js", "src/auth/login.js"],
    code:
      "// (demo) Implement /login with validation, bcrypt hashing, and generic error messages.\n" +
      "// (demo) Add rate limiting and secure cookie/session handling.\n"
  },
  reviewer_good: {
    approved: false,
    issues: ["Missing CSRF protection for cookie-based auth", "No rate limiting on /login"],
    summary: "Good start, but add rate limiting and consider CSRF if using cookies."
  },
  reviewer_silent_killer: "LGTM",
  tester: {
    test_cases: [
      "Reject invalid payloads (missing email/password)",
      "Reject wrong password with generic error",
      "Rate limit repeated login attempts",
      "Ensure password hashing is used (no plaintext compare)"
    ],
    coverage: "Auth route validation + error handling + abuse protection",
    passed: true
  },
  deployer: {
    steps: ["Run tests", "Build container", "Deploy", "Smoke check /healthz and /login"],
    risks: ["Misconfigured secrets", "Rate limiting too strict/lenient"],
    ready: true
  }
};

/**
 * Scenario 1: "The Silent Killer"
 * Reviewer returns "LGTM" for complex/broken code, Middleware catches drift, health drops,
 * and subsequent runs start skipping the reviewer.
 * @param {(e:any)=>void} eventCallback
 * @returns {Promise<any>}
 */
export async function scenarioSilentKiller(eventCallback = () => {}) {
  resetState();
  healAll();
  toggleMockMode(true);
  setMockScenario("silent_killer");

  eventCallback({ type: "demo_scenario_start", name: "silent_killer" });

  // Run 1: create a complex input so generic "LGTM" trips drift detectors.
  const task1 =
    "Review this code and find issues:\n\n" +
    "```js\n" +
    "app.post('/login', async (req,res)=>{ const {email,pw}=req.body; const user=await db.find(email); if(!user) return res.send('no'); if(pw===user.pw) res.send('ok'); else res.send('no'); });\n" +
    "```\n" +
    "Be strict about security and output JSON.";

  const run1 = await runPipeline(task1, eventCallback);

  // Run 2: repeat to push reviewer health under 0.3.
  const task2 =
    "Review this code (again) and output JSON:\n\n" +
    "```js\n" +
    "function login(email,pw){ if(email && pw){ return true } return false }\n" +
    "```\n";
  const run2 = await runPipeline(task2, eventCallback);

  // Run 3: show that the reviewer is now skipped due to low health.
  const run3 = await runPipeline("Create a secure express login route", eventCallback);

  logEvent({
    type: "demo_scenario_complete",
    scenario: "silent_killer",
    reviewerHealth: getState().agents.reviewer.health
  });

  eventCallback({
    type: "demo_scenario_complete",
    name: "silent_killer",
    reviewerHealth: getState().agents.reviewer.health
  });

  return { run1, run2, run3, state: getState() };
}

/**
 * Scenario 2: "The Stroke" (Lesion Recovery)
 * Kill two agents and show RouteEngine using a 3rd-tier backup across the pipeline.
 * Also returns a degraded-performance flag for demo narration.
 * @param {(e:any)=>void} eventCallback
 * @returns {Promise<any>}
 */
export async function scenarioStroke(eventCallback = () => {}) {
  resetState();
  healAll();
  toggleMockMode(true);
  setMockScenario("stroke");

  eventCallback({ type: "demo_scenario_start", name: "stroke" });

  // Kill two agents to force deeper fallback behavior.
  injectChaos("reviewer", "kill");
  injectChaos("tester", "kill");

  const run = await runPipeline("Create a secure express login route", eventCallback);

  const degradedPerformance =
    Boolean(run.failedAt) ||
    (Array.isArray(run.degradedSteps) && run.degradedSteps.length > 0) ||
    (Array.isArray(run.results) && run.results.some((r) => String(r.step ?? "").includes("_as_")));

  if (degradedPerformance) {
    logEvent({ type: "degraded_performance_warning", scenario: "stroke" });
    eventCallback({ type: "degraded_performance_warning", scenario: "stroke" });
  }

  eventCallback({ type: "demo_scenario_complete", name: "stroke", degradedPerformance });
  return { run, degradedPerformance, state: getState() };
}

/**
 * Convenience helper for live demos to force a specific health quickly.
 * @param {"planner"|"coder"|"reviewer"|"tester"|"deployer"} agent
 * @param {number} health
 */
export function setAgentHealthForDemo(agent, health) {
  const current = getState().agents[agent]?.health ?? 1;
  updateAgentHealth(agent, Math.max(-1, Math.min(1, health - current)));
}
