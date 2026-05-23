# Skill: health-monitor
Tracks per-agent health over time and updates system-level reliability metrics.
Rules: use middleware drift scores + latency to adjust health (heal on clean fast runs, damage on drift/timeouts), update status (`healthy/degraded/critical/dead`), and log every change as an event for dashboards. Prefer stable, incremental updates over noisy oscillations.
