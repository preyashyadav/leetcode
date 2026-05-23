import { GoogleGenAI } from "@google/genai";
import { GEMINI_API_KEY } from "./config.js";

export const AXONLOTL_MANAGED_AGENT_ID = "axonlotl-immune-system";
export const AXONLOTL_BASE_AGENT = "antigravity-preview-05-2026";

const client = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

/** @type {any} */
let cachedEnvironmentRef = null; // string env id OR {type:'remote', ...}

function safeJsonParse(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return { ok: false, error: "empty" };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    // continue
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    try {
      return { ok: true, value: JSON.parse(fenced[1].trim()) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { ok: false, error: "unparseable" };
}

/**
 * Register (or ensure existence of) the Axonlotl managed agent.
 * Uses the Gemini Interactions API agent registry via `client.agents`.
 * @returns {Promise<any>}
 */
export async function registerManagedAgent() {
  try {
    const agent = await client.agents.get(AXONLOTL_MANAGED_AGENT_ID);
    cachedEnvironmentRef = agent?.base_environment ?? cachedEnvironmentRef;
    return agent;
  } catch {
    // create if not found / not accessible
  }

  const created = await client.agents.create({
    id: AXONLOTL_MANAGED_AGENT_ID,
    base_agent: AXONLOTL_BASE_AGENT,
    // NOTE: The Interactions API requires an `environment` field on calls. We prefer using
    // the agent's `base_environment` if it is an environment id/string; otherwise default
    // to remote environment config.
    base_environment: { type: "remote" },
    description:
      "Axonlotl Immune System: meta-orchestrator that diagnoses and heals a multi-agent pipeline.",
    system_instruction:
      "You are Axonlotl-Core, a managed immune analysis agent for a brain-inspired multi-agent system. " +
      "Your job is to produce a single concise, high-signal clinical summary suitable for a live demo. " +
      "When rerouting/plasticity occurs, explicitly mention 'structural bypass' and the updated synaptic weight. " +
      "Always reference one of the three Brain Patterns (Pattern 1 Fast Path, Pattern 2 LTP, Pattern 3 Lesion Recovery) in your verdict. " +
      "Return ONLY JSON: {\"summary\": \"...\"}."
  });
  cachedEnvironmentRef = created?.base_environment ?? cachedEnvironmentRef ?? { type: "remote" };
  return created;
}

async function resolveEnvironmentForAgent() {
  if (cachedEnvironmentRef) return cachedEnvironmentRef;
  try {
    const agent = await client.agents.get(AXONLOTL_MANAGED_AGENT_ID);
    cachedEnvironmentRef = agent?.base_environment ?? null;
  } catch {
    // ignore
  }
  return cachedEnvironmentRef ?? { type: "remote" };
}

/**
 * Get a 'Medical Report' diagnosis for the current network state.
 * Sends the full JSON state to the managed agent via `client.interactions.create`.
 * @param {any} networkState
 * @returns {Promise<{success:boolean, note?:string, report?:any, raw?:string, error?:string}>}
 */
export async function getBrainDiagnosis(networkState) {
  try {
    await registerManagedAgent();
    const environment = await resolveEnvironmentForAgent();

    const payload = networkState ?? {};
    const results = Array.isArray(payload?.results) ? payload.results : Array.isArray(payload?.networkState?.results) ? payload.networkState.results : [];
    let worst = { agent: "unknown", drift: 0 };
    for (const r of results) {
      const d = Number(r?.drift?.drift_score ?? r?.drift_score ?? 0);
      if (Number.isFinite(d) && d > worst.drift) worst = { agent: String(r?.agent ?? r?.step ?? "unknown"), drift: d };
    }

    const input = [
      "You are the Axonlotl Prefrontal Cortex.",
      "Generate a sharp, one-sentence medical warning when semantic drift is high, and a confident readiness statement when the network is healthy.",
      `Context: worst drift observed = ${worst.drift.toFixed(2)} in node "${worst.agent}".`,
      "If drift is >= 0.80: explicitly warn about 'Neural Hallucination' and mention how you rerouted to preserve intent.",
      "If overall health is high and drift is low: say exactly: \"Neural integrity at 100%. System primed for task execution.\"",
      "Be specific and quantified when possible (health values, reroute edges, synaptic weights).",
      "CRUCIAL: Your final verdict MUST explicitly reference Pattern 1, Pattern 2, or Pattern 3 by name.",
      "Return ONLY valid JSON: {\"summary\":\"...\"}. Vary your reasoning across runs; do not repeat templates verbatim.",
      "",
      "payload:",
      JSON.stringify(networkState, null, 2)
    ].join("\n");

    const interaction = await client.interactions.create({
      agent: AXONLOTL_MANAGED_AGENT_ID,
      input,
      environment
    });

    const raw = String(interaction?.output_text ?? interaction?.text ?? interaction?.output ?? "");
    const parsed = safeJsonParse(raw);
    if (!parsed.ok) {
      const fallback = synthesizeClinicalSummary(networkState);
      return {
        success: false,
        note: fallback,
        raw,
        error: `Managed agent returned non-JSON: ${parsed.error}`
      };
    }

    const report = parsed.value;
    const note =
      typeof report?.summary === "string"
        ? report.summary
        : typeof report?.note === "string"
          ? report.note
          : raw;

    return { success: true, note, report, raw };
  } catch (error) {
    const fallback = synthesizeClinicalSummary(networkState);
    return {
      success: false,
      note: fallback,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function synthesizeClinicalSummary(payload) {
  try {
    const ns = payload?.networkState ?? payload;
    const agents = ns?.agents ?? {};
    const dead = Object.entries(agents)
      .filter(([, a]) => Number(a?.health ?? 1) === 0)
      .map(([k]) => k);

    const routeWeights = payload?.routeWeights ?? ns?.routeWeights ?? {};
    const entries = Object.entries(routeWeights).map(([k, v]) => ({
      key: k,
      weight: typeof v?.weight === "number" ? v.weight : typeof v === "number" ? v : 0
    }));
    entries.sort((a, b) => b.weight - a.weight);
    const top = entries[0];

    const pick = (options) => {
      const seed =
        String(top?.key ?? "none").length +
        Math.floor((Date.now() / 60000) % 1000) +
        (dead.length ? 7 : 0);
      return options[seed % options.length];
    };

    if (top && top.weight > 0) {
      const templates = [
        (k, w) =>
          `Structural bypass initiated. Synaptic weights for ${k} increased to ${w.toFixed(
            2
          )} to maintain pipeline integrity.`,
        (k, w) =>
          `Network stabilizing through reinforced paths. Promoting ${k} as the primary recovery route (weight ${w.toFixed(
            2
          )}).`,
        (k, w) =>
          `Functional compensation engaged. Redirecting load via ${k}; potentiation updated to ${w.toFixed(
            2
          )} to preserve throughput.`,
        (k, w) =>
          `Lesion recovery successful. Cross-functional bypass via ${k} now preferred (synaptic strength ${w.toFixed(
            2
          )}).`
      ];
      const t = pick(templates);
      return t(top.key, top.weight);
    }
    if (dead.length) {
      const templates = [
        () =>
          `Multiple organ failure detected (${dead.join(
            ", "
          )}). Forcing cross-functional bypass and suppressing unstable nodes.`,
        () =>
          `Lesion detected (${dead.join(
            ", "
          )}). Recommend compensatory rerouting via capability overlap while plasticity weights relearn.`,
        () =>
          `Critical node loss observed (${dead.join(
            ", "
          )}). Initiating graceful degradation and prioritizing shortest viable detours.`
      ];
      return pick(templates)();
    }
    const stableTemplates = [
      "Clinical note: network stable; monitor drift and reinforce successful recovery routes.",
      "Clinical note: pipeline integrity nominal; maintain drift surveillance and keep potentiating successful edges.",
      "Clinical note: system stable under current load; continue strengthening high-coverage fallbacks."
    ];
    return pick(stableTemplates);
  } catch {
    return "Clinical note: network stable; monitor drift and reinforce successful recovery routes.";
  }
}
