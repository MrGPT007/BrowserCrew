import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
await execFileAsync(process.execPath, ["--check", "scripts/skill-replay-resilience-smoke.mjs"]);
await execFileAsync(process.execPath, ["--check", "scripts/skill-replay-resilience-check.mjs"]);

const runtime = await readFile("src/skills-runtime.js", "utf8");
for (const phrase of [
  "reconcileInterruptedSkillRuns",
  'if (run.status !== "running") continue',
  'run.status = "paused"',
  'code: "SKILL_WORKER_RESTARTED"',
  "The run was paused and will not replay an uncertain step automatically."
]) assert.ok(runtime.includes(phrase), `Replay restart fail-safe contract missing: ${phrase}`);

const smoke = await readFile("scripts/skill-replay-resilience-smoke.mjs", "utf8");
for (const phrase of [
  "Target.closeTarget",
  "First reviewed click should execute exactly once before suspension.",
  "Durable run should show completed first click and pending wait intent before suspension.",
  'run?.status === "paused" && run.error?.code === "SKILL_WORKER_RESTARTED"',
  "Worker restart must not replay the already completed write.",
  "Worker restart must not continue to later write steps automatically.",
  "MV3 restart pauses the exact durable replay without duplicate writes or automatic continuation",
  'data-prepare-writes="0"',
  'data-finish-writes="0"'
]) assert.ok(smoke.includes(phrase), `Replay suspension installed-extension proof missing: ${phrase}`);

const runner = await readFile("scripts/previous-stable-runner.mjs", "utf8");
assert.ok(runner.includes('"skill-replay-resilience-smoke.mjs"'), "Chrome 152 matrix must include Skill replay suspension coverage.");
const pkg = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(pkg.scripts?.["skill-replay-resilience-check"], "node scripts/skill-replay-resilience-check.mjs");
assert.equal(pkg.scripts?.["skill-replay-resilience-smoke"], "node scripts/skill-replay-resilience-smoke.mjs");
assert.ok(String(pkg.scripts?.["skill-run-ui-smoke"] || "").includes("node scripts/skill-replay-resilience-smoke.mjs"), "Current Chrome combined Skill gate must include replay suspension.");
assert.ok(String(pkg.scripts?.check || "").includes("skill-replay-resilience-check.mjs"));

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
assert.equal((manifest.permissions || []).includes("alarms"), false);
const serviceWorker = await readFile("src/service-worker.js", "utf8");
assert.equal(serviceWorker.includes("bootSchedulesRuntime"), false);

console.log("BrowserCrew approved Skill replay restart resilience contracts passed.");
