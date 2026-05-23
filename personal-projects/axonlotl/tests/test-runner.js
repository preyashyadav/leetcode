/**
 * Simple test runner placeholder for early phases.
 * Later phases can replace this with a real runner (vitest/jest) if desired.
 */

function fail(message) {
  // eslint-disable-next-line no-console
  console.error(message);
  process.exitCode = 1;
}

async function main() {
  // Smoke check: config import and required exports exist.
  const config = await import("../src/config.js");
  if (!("GEMINI_API_KEY" in config)) fail("Missing export: GEMINI_API_KEY");
  if (!("PORT" in config)) fail("Missing export: PORT");
}

main();

