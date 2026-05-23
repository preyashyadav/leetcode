import http from "http";
import express from "express";
import { WebSocketServer } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import { HOST, PORT } from "./config.js";
import { runPipeline, runPipelineWithoutHealing } from "./orchestrator.js";
import { injectChaos, healAgent } from "./chaos-engine.js";
import { healAll } from "./chaos-engine.js";
import { getState } from "./network-state.js";
import { resetNetwork } from "./network-state.js";
import { getBrainDiagnosis } from "./managed-agent.js";
import { toggleMockMode, getMockMode, setMockScenario } from "./worker-agents.js";
import { scenarioSilentKiller, scenarioStroke } from "./demo-scenarios.js";
import { runShadowTest } from "./chaos-engine.js";

/**
 * Create the HTTP + WebSocket server for Axonlotl.
 * (Minimal scaffolding; routes and message handlers added in later phases.)
 * @returns {{server: http.Server, wss: WebSocketServer, app: import("express").Express}}
 */
export function createServer() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const frontendDir = path.resolve(__dirname, "../frontend");
  app.use(express.static(frontendDir));

  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.get("/api/state", (_req, res) => {
    res.json({ ok: true, state: getState() });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  wss.on("error", () => {
    // avoid crashing on listen/bind failures in restricted environments
  });

  function broadcast(event) {
    const msg = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(msg);
    }
  }

  /** @type {ReturnType<typeof setInterval> | null} */
  let shadowInterval = null;

  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "hello", service: "axonlotl" }));
  });

  app.post("/api/run", async (req, res) => {
    const task = req.body?.task ?? "Build a simple hello world Express API";
    const mode = req.body?.mode ?? "axonlotl"; // "axonlotl" | "brittle"
    const runId = `run_${Date.now()}`;

    const events = [];
    const cb = (e) => {
      const event = { runId, ...e };
      events.push(event);
      broadcast(event);
    };

    broadcast({ type: "run_start", runId, mode });

    try {
      const result =
        mode === "brittle"
          ? await runPipelineWithoutHealing(task, cb)
          : await runPipeline(task, cb);

      // Immediately after pipeline finishes, ask the managed agent (Brain) for a clinical summary.
      // This should never break the run if the managed-agent call fails.
      try {
        const state = getState();
        const diagnosisInput = {
          task,
          mode,
          results: result?.results ?? null,
          routeWeights: state?.routeWeights ?? null,
          networkState: state
        };
        const diag = await getBrainDiagnosis(diagnosisInput);
        const text = diag?.note ?? diag?.report?.summary ?? diag?.raw ?? diag?.error ?? "Diagnosis unavailable";
        cb({ type: "brain_diagnosis", text });
      } catch (error) {
        cb({
          type: "brain_diagnosis",
          text: error instanceof Error ? error.message : String(error)
        });
      }

      broadcast({ type: "run_end", runId });
      res.json({ ok: true, runId, result, events });
    } catch (error) {
      broadcast({
        type: "run_error",
        runId,
        error: error instanceof Error ? error.message : String(error)
      });
      res.status(500).json({ ok: false, runId, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/chaos", (req, res) => {
    const agent = req.body?.agent;
    const action = req.body?.action ?? "kill"; // "kill" | "heal"
    if (!agent) return res.status(400).json({ ok: false, error: "Missing agent" });

    try {
      if (action === "heal") healAgent(agent);
      else injectChaos(agent, "kill");

      const state = getState();
      broadcast({ type: "agent_state", agent, state: state.agents[agent] });
      return res.json({ ok: true, agent, state: state.agents[agent] });
    } catch (error) {
      return res
        .status(500)
        .json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/heal_all", (_req, res) => {
    try {
      healAll();
      const state = getState();
      for (const agent of Object.keys(state.agents)) {
        broadcast({ type: "agent_state", agent, state: state.agents[agent] });
      }
      broadcast({ type: "global_heal" });
      res.json({ ok: true, state });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/reset_network", (_req, res) => {
    try {
      const state = resetNetwork();
      for (const agent of Object.keys(state.agents)) {
        broadcast({ type: "agent_state", agent, state: state.agents[agent] });
      }
      broadcast({ type: "route_weights", routeWeights: state.routeWeights });
      broadcast({ type: "network_reset" });
      res.json({ ok: true, state });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Curl-friendly aliases requested by Phase 6/verification scripts
  app.post("/inject_fault", (req, res) => {
    const agent = req.body?.agentName ?? req.body?.agent;
    const faultType = req.body?.faultType ?? req.body?.fault ?? "kill";
    try {
      if (faultType === "kill") injectChaos(agent, "kill");
      else if (faultType === "degrade") injectChaos(agent, "degrade");
      else if (faultType === "hallucinate") injectChaos(agent, "hallucinate");
      else if (faultType === "slow") injectChaos(agent, "slow");
      else return res.status(400).json({ ok: false, error: "Unknown faultType" });
      const state = getState();
      broadcast({ type: "agent_state", agent, state: state.agents[agent] });
      return res.json({ ok: true, state: state.agents[agent] });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/run_pipeline", async (req, res) => {
    const task = req.body?.task ?? "Build a simple hello world Express API";
    const mode = req.body?.mode ?? "axonlotl"; // "axonlotl" | "brittle"
    const runId = `run_${Date.now()}`;

    const events = [];
    const cb = (e) => {
      const event = { runId, ...e };
      events.push(event);
      broadcast(event);
    };

    broadcast({ type: "run_start", runId, mode });

    try {
      const result =
        mode === "brittle"
          ? await runPipelineWithoutHealing(task, cb)
          : await runPipeline(task, cb);

      try {
        const state = getState();
        const diagnosisInput = {
          task,
          mode,
          results: result?.results ?? null,
          routeWeights: state?.routeWeights ?? null,
          networkState: state
        };
        const diag = await getBrainDiagnosis(diagnosisInput);
        const text = diag?.note ?? diag?.report?.summary ?? diag?.raw ?? diag?.error ?? "Diagnosis unavailable";
        cb({ type: "brain_diagnosis", text });
      } catch (error) {
        cb({
          type: "brain_diagnosis",
          text: error instanceof Error ? error.message : String(error)
        });
      }

      broadcast({ type: "run_end", runId });
      res.json({ ok: true, runId, result, events });
    } catch (error) {
      broadcast({
        type: "run_error",
        runId,
        error: error instanceof Error ? error.message : String(error)
      });
      res
        .status(500)
        .json({ ok: false, runId, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/diagnose", async (_req, res) => {
    try {
      const state = getState();
      const diag = await getBrainDiagnosis(state);
      res.json({ ok: true, diagnosis: diag, note: diag?.note ?? null });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/mock", (_req, res) => {
    res.json({ ok: true, mock: getMockMode() });
  });

  app.post("/api/mock", (req, res) => {
    const enabled = req.body?.enabled;
    const scenario = req.body?.scenario;
    if (typeof enabled !== "undefined") toggleMockMode(Boolean(enabled));
    if (typeof scenario !== "undefined") setMockScenario(String(scenario));
    broadcast({ type: "mock_mode", ...getMockMode() });
    res.json({ ok: true, mock: getMockMode() });
  });

  app.post("/api/demo/:name", async (req, res) => {
    const name = String(req.params.name ?? "");
    const events = [];
    const cb = (e) => {
      events.push(e);
      broadcast(e);
      try {
        req.body?.eventCallback?.(e);
      } catch {
        // ignore
      }
    };

    try {
      if (name === "silent-killer") {
        const result = await scenarioSilentKiller(cb);
        return res.json({ ok: true, name, result, events });
      }
      if (name === "stroke") {
        const result = await scenarioStroke(cb);
        return res.json({ ok: true, name, result, events });
      }
      return res.status(404).json({ ok: false, error: "Unknown demo scenario" });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/shadow/start", (req, res) => {
    const intervalMs = Number(req.body?.intervalMs ?? 30_000);
    const miniSteps = Number(req.body?.miniSteps ?? 2);
    const task = req.body?.task ?? "Create a secure express login route";

    if (shadowInterval) clearInterval(shadowInterval);

    shadowInterval = setInterval(async () => {
      try {
        const update = await runShadowTest(task, (e) => broadcast(e), miniSteps, "kill");
        broadcast({ type: "shadow_update", ...update });
      } catch (error) {
        broadcast({ type: "shadow_error", error: error instanceof Error ? error.message : String(error) });
      }
    }, intervalMs);

    broadcast({ type: "shadow_started", intervalMs, miniSteps });
    res.json({ ok: true, started: true, intervalMs, miniSteps });
  });

  app.post("/api/shadow/stop", (_req, res) => {
    if (shadowInterval) clearInterval(shadowInterval);
    shadowInterval = null;
    broadcast({ type: "shadow_stopped" });
    res.json({ ok: true, stopped: true });
  });

  return { server, wss, app };
}

/**
 * Start the server.
 * @returns {Promise<http.Server>}
 */
export async function startServer() {
  const { server } = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, resolve);
  });
  return server;
}

if (process.argv[1]?.endsWith("src/server.js")) {
  startServer().then(() => {
    console.log(`Axonlotl server listening on http://${HOST}:${PORT}`);
  });
}
