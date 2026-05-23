/**
 * MiddlewareInterceptor: sits between each pipeline agent call.
 *
 * Exports the three hooks requested by the spec:
 * - before_agent(agentName, taskInput, networkState)
 * - modify_request(agentName, taskInput, networkState)
 * - after_agent(agentName, taskInput, agentOutput, networkState)
 */

const MAX_INPUT_CHARS = 10_000;

/** @type {Map<string, string>} */
const lastOutputByAgent = new Map();

function toText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateText(text, maxChars) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

function looksLikeCode(text) {
  const t = text.toLowerCase();
  const hasBraces = /[{}()[\];]/.test(text);
  const hasManyNewlines = (text.match(/\n/g) ?? []).length >= 5;
  const hasKeywords = /\b(function|class|import|export|const|let|var|def|return|if|else|for|while)\b/.test(
    t
  );
  return hasBraces || hasManyNewlines || hasKeywords;
}

function includesGenericApproval(text) {
  const t = text.toLowerCase();
  return (
    t.includes("lgtm") ||
    t.includes("looks good") ||
    t.includes("no issues")
  );
}

function parseJsonIfPossible(text) {
  const trimmed = text.trim();
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
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      return { ok: true, value: JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  return { ok: false, error: "unparseable" };
}

/**
 * before_agent(agentName, taskInput, networkState)
 * @param {string} agentName
 * @param {unknown} taskInput
 * @param {any} networkState
 * @returns {{proceed: boolean, modified_input: string, blocked: boolean, reason: string}}
 */
export function before_agent(agentName, taskInput, networkState) {
  const text = toText(taskInput).trim();
  if (!text) {
    return {
      proceed: false,
      modified_input: "",
      blocked: true,
      reason: "empty input"
    };
  }

  const agent = networkState?.agents?.[agentName];
  if (!agent) {
    return {
      proceed: false,
      modified_input: text,
      blocked: true,
      reason: "unknown agent"
    };
  }

  if (agent.health === 0) {
    return {
      proceed: false,
      modified_input: text,
      blocked: true,
      reason: "agent dead"
    };
  }

  const modified = truncateText(text, MAX_INPUT_CHARS);
  return {
    proceed: true,
    modified_input: modified,
    blocked: false,
    reason: ""
  };
}

/**
 * modify_request(agentName, taskInput, networkState)
 * @param {string} agentName
 * @param {unknown} taskInput
 * @param {any} networkState
 * @returns {{modified_input: string}}
 */
export function modify_request(agentName, taskInput, networkState) {
  const base = toText(taskInput);
  const agent = networkState?.agents?.[agentName];
  const health = typeof agent?.health === "number" ? agent.health : 1;

  if (health < 0.5) {
    const prefix =
      "[OPERATING IN DEGRADED MODE — be concise, prioritize accuracy over completeness]\n";
    return { modified_input: `${prefix}${base}` };
  }

  return { modified_input: base };
}

/**
 * after_agent(agentName, taskInput, agentOutput, networkState)
 * Semantic drift detection and output sanitization.
 * @param {string} agentName
 * @param {unknown} taskInput
 * @param {unknown} agentOutput
 * @param {any} networkState
 * @returns {{drift_score: number, passed: boolean, flags: string[], output: any}}
 */
export function after_agent(agentName, taskInput, agentOutput, networkState) {
  const flags = [];
  const scores = [];

  const inputText = toText(taskInput);

  let outputText = "";
  if (typeof agentOutput === "string") outputText = agentOutput;
  else if (agentOutput && typeof agentOutput === "object") {
    // common shapes: { output: "..." }, { raw: "...", output: {...} }, etc.
    if (typeof agentOutput.output === "string") outputText = agentOutput.output;
    else if (typeof agentOutput.raw === "string") outputText = agentOutput.raw;
    else outputText = toText(agentOutput.output ?? agentOutput);
  } else {
    outputText = toText(agentOutput);
  }

  const normalizedOutput = outputText.trim();

  // 5. Empty or null output → drift score 1.0
  if (!normalizedOutput) {
    flags.push("empty_output");
    scores.push(1.0);
  }

  // 1. Input length vs output length ratio
  if (inputText.length > 500 && normalizedOutput.length < 50) {
    flags.push("length_mismatch");
    scores.push(0.7);
  }

  // 2. Generic response detection
  if (
    includesGenericApproval(normalizedOutput) &&
    (inputText.length > 500 || looksLikeCode(inputText))
  ) {
    flags.push("generic_response");
    scores.push(0.8);
  }

  // 3. JSON schema validation (expected JSON but isn't parseable)
  if (normalizedOutput) {
    const parsed = parseJsonIfPossible(normalizedOutput);
    if (!parsed.ok) {
      flags.push("invalid_json");
      scores.push(0.9);
    }
  }

  // 4. Repetition detection (identical to last output from this agent)
  if (normalizedOutput) {
    const last = lastOutputByAgent.get(agentName);
    if (last != null && last === normalizedOutput) {
      flags.push("repetition_loop");
      scores.push(1.0);
    }
    lastOutputByAgent.set(agentName, normalizedOutput);
  }

  const drift_score = scores.length ? Math.max(...scores) : 0.0;
  const passed = drift_score < 0.5;

  // "Possibly sanitized": for convenience, if JSON is parseable, expose parsed form.
  const parsed = normalizedOutput ? parseJsonIfPossible(normalizedOutput) : { ok: false };
  const sanitized =
    parsed.ok && agentOutput && typeof agentOutput === "object"
      ? { ...agentOutput, parsed_output: parsed.value }
      : parsed.ok
        ? { output: agentOutput, parsed_output: parsed.value }
        : agentOutput;

  void networkState; // reserved for later signal enrichment

  return { drift_score, passed, flags, output: sanitized };
}
