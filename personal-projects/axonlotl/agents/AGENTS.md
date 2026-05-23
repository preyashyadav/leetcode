# Axonlotl Orchestrator — Technical Manual

Axonlotl is a brain-inspired, self-healing orchestrator for multi-agent pipelines.
It manages a network of specialist worker agents (`planner`, `coder`, `reviewer`, `tester`, `deployer`)
and keeps the overall system reliable under failures, drift, and latency.

## Core Operating Model

### 1) Fast Paths (Graceful Degradation)
When an agent’s health declines, Axonlotl reduces cognitive load instead of failing hard.
- `health > 0.7`: normal execution
- `0.3 ≤ health ≤ 0.7`: degraded mode (shorter prompts, prioritize correctness)
- `health < 0.3`: skip the agent and attempt lesion recovery via rerouting

### 2) LTP (Long-Term Potentiation) — Neuroplastic Adaptation
Axonlotl strengthens or prunes reroute edges based on outcome history.
- Successful cover routes increase `routeWeights["A→B"].weight`
- Failed cover routes decrease weight
- Future routing prefers `(coverage × weight)` so the network learns over time

### 3) Lesion Recovery (Compensatory Rerouting)
When an agent is dead/critical or semantic drift is detected:
- Consult `capabilityMap[failedAgent]` for candidate covering agents
- Filter candidates by `health > 0.3`
- Choose best candidate by `coverage` and plasticity weights
- Replace step `failedAgent` with `covering_as_failed` (cover mode) and continue pipeline

## Semantic Drift Detection (Middleware)
Axonlotl detects semantic failures by comparing input complexity to output quality.
Signals include length mismatch, generic approvals on complex inputs, invalid JSON, repetition loops, and empty outputs.
Drift is scored `0.0–1.0`; drift `>= 0.5` triggers lesion recovery.

## Required Output Format
Always respond with structured JSON when acting as the orchestrator or managed agent:
`{ "type": "...", "summary": "...", "events": [...], "recommendations": [...] }`

