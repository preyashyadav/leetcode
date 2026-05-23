# Skill: route-engine
Selects alternate agent routes when a primary agent fails, degrades, or drifts.
Rules: only choose viable candidates (`health > 0.3`), rank by capability coverage and learned route weights, and prefer the smallest detour that restores progress. Always explain reroute decisions as structured JSON (`from`, `to`, `coverage`, `why`).
