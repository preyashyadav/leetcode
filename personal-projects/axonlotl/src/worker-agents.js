import { GoogleGenAI } from "@google/genai";
import { GEMINI_API_KEY } from "./config.js";
import { DEMO_CACHE } from "./demo-scenarios.js";

const MODEL = "gemini-3.5-flash";

/** @type {Record<"planner"|"coder"|"reviewer"|"tester"|"deployer", string>} */
const SYSTEM_PROMPTS = {
  planner:
    "You are a software project planner. Break the task into subtasks. Output JSON: { subtasks: [...], analysis: '...' }",
  coder:
    "You are a developer. Write code for the given subtasks. Output JSON: { code: '...', language: '...', files: [...] }",
  reviewer:
    "You are a code reviewer. Find bugs, security issues, style problems. Output JSON: { approved: bool, issues: [...], summary: '...' }",
  tester:
    "You are a QA tester. Design and describe test cases. Output JSON: { test_cases: [...], coverage: '...', passed: bool }",
  deployer:
    "You are a deployment engineer. Create deployment plan. Output JSON: { steps: [...], risks: [...], ready: bool }"
};

const client = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

let MOCK_MODE = false;
let MOCK_SCENARIO = "default";
let MOCK_CALL_SEQ = 0;

/**
 * Toggle mock mode for demo fail-safes (rate limits / wifi issues).
 * When enabled, worker agents return pre-cached demo JSON but the event flow stays identical.
 * @param {boolean} on
 * @returns {boolean}
 */
export function toggleMockMode(on) {
  MOCK_MODE = Boolean(on);
  return MOCK_MODE;
}

/**
 * Set the active mock scenario.
 * @param {string} name
 * @returns {string}
 */
export function setMockScenario(name) {
  MOCK_SCENARIO = String(name ?? "default");
  MOCK_CALL_SEQ = 0;
  return MOCK_SCENARIO;
}

/**
 * @returns {{enabled:boolean, scenario:string}}
 */
export function getMockMode() {
  return { enabled: MOCK_MODE, scenario: MOCK_SCENARIO };
}

/**
 * Extract a JSON object from model output.
 * Supports raw JSON and ```json fenced blocks.
 * @param {string} text
 * @returns {object}
 */
function parseModelJson(text) {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // continue
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    return JSON.parse(candidate);
  }

  throw new Error("Unparseable JSON from model output");
}

/**
 * Build the prompt sent to Gemini for a role.
 * @param {"planner"|"coder"|"reviewer"|"tester"|"deployer"} role
 * @param {unknown} taskInput
 * @param {string | null} coverPrefix
 * @returns {string}
 */
function buildPrompt(role, taskInput, coverPrefix) {
  const system = SYSTEM_PROMPTS[role];
  const userText =
    typeof taskInput === "string" ? taskInput : JSON.stringify(taskInput, null, 2);

  const parts = [];
  if (coverPrefix) parts.push(coverPrefix);
  parts.push(system);
  parts.push("");
  parts.push("TASK INPUT:");
  parts.push(userText);
  parts.push("");
  parts.push("Return ONLY valid JSON.");
  return parts.join("\n");
}

/**
 * Run a worker agent role against Gemini 3.5 Flash.
 * @param {"planner"|"coder"|"reviewer"|"tester"|"deployer"} role
 * @param {unknown} taskInput
 * @returns {Promise<{agent: string, success: boolean, output?: object, responseTime: number, raw?: string, error?: string}>}
 */
export async function runWorkerAgent(role, taskInput) {
  const start = Date.now();

  if (!(role in SYSTEM_PROMPTS)) {
    return {
      agent: role,
      success: false,
      error: `Unknown role: ${role}`,
      responseTime: Date.now() - start
    };
  }

  try {
    if (MOCK_MODE) {
      const callId = ++MOCK_CALL_SEQ;
      const responseTime = Date.now() - start || 5;
      if (role === "reviewer" && MOCK_SCENARIO === "silent_killer") {
        // Intentionally non-JSON generic response to trigger semantic drift detectors.
        return {
          agent: role,
          success: false,
          error: "Unparseable JSON from model output",
          responseTime,
          raw: String(DEMO_CACHE.reviewer_silent_killer)
        };
      }

      const mock =
        role === "reviewer" ? DEMO_CACHE.reviewer_good : DEMO_CACHE[role];

      const payload =
        mock && typeof mock === "object"
          ? { ...mock, __mock: { scenario: MOCK_SCENARIO, callId } }
          : mock;
      return {
        agent: role,
        success: true,
        output: payload,
        responseTime,
        raw: JSON.stringify(payload)
      };
    }

    const prompt = buildPrompt(role, taskInput, null);
    const response = await client.models.generateContent({
      model: MODEL,
      contents: prompt
    });

    const raw = (response?.text ?? "").toString();
    const output = parseModelJson(raw);

    return {
      agent: role,
      success: true,
      output,
      responseTime: Date.now() - start,
      raw
    };
  } catch (error) {
    return {
      agent: role,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      responseTime: Date.now() - start
    };
  }
}

/**
 * Run a worker agent in cover mode (coveringRole covers for originalRole).
 * Prepends an explicit prefix to the prompt to indicate cover behavior.
 * @param {"planner"|"coder"|"reviewer"|"tester"|"deployer"} originalRole
 * @param {"planner"|"coder"|"reviewer"|"tester"|"deployer"} coveringRole
 * @param {unknown} taskInput
 * @returns {Promise<{agent: string, success: boolean, output?: object, responseTime: number, raw?: string, error?: string}>}
 */
export async function runWorkerAgentInCoverMode(
  originalRole,
  coveringRole,
  taskInput
) {
  const start = Date.now();

  if (!(coveringRole in SYSTEM_PROMPTS)) {
    return {
      agent: coveringRole,
      success: false,
      error: `Unknown covering role: ${coveringRole}`,
      responseTime: Date.now() - start
    };
  }

  try {
    if (MOCK_MODE) {
      const callId = ++MOCK_CALL_SEQ;
      const responseTime = Date.now() - start || 5;
      // Cover-mode uses the coveringRole's "best effort"; we reuse cached output.
      const mock =
        coveringRole === "reviewer" ? DEMO_CACHE.reviewer_good : DEMO_CACHE[coveringRole];
      const payload =
        mock && typeof mock === "object"
          ? { ...mock, __mock: { scenario: MOCK_SCENARIO, callId, coverFor: originalRole } }
          : mock;
      return {
        agent: coveringRole,
        success: true,
        output: payload,
        responseTime,
        raw: JSON.stringify(payload)
      };
    }

    const prefix = `[OPERATING IN COVER MODE — you are a ${coveringRole} covering for ${originalRole}.\nDo your best to perform ${originalRole}'s task with your capabilities.]`;
    const prompt = buildPrompt(coveringRole, taskInput, prefix);

    const response = await client.models.generateContent({
      model: MODEL,
      contents: prompt
    });

    const raw = (response?.text ?? "").toString();
    const output = parseModelJson(raw);

    return {
      agent: coveringRole,
      success: true,
      output,
      responseTime: Date.now() - start,
      raw
    };
  } catch (error) {
    return {
      agent: coveringRole,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      responseTime: Date.now() - start
    };
  }
}
