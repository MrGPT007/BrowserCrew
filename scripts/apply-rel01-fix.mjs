import { readFile, writeFile } from "node:fs/promises";

const path = "src/background.js";
let source = await readFile(path, "utf8");

function replaceOnce(before, after, label) {
  if (source.includes(after)) return;
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`REL-01 patch could not find: ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`REL-01 patch found more than one match: ${label}`);
  source = source.replace(before, after);
}

replaceOnce(
  'const MAX_SKILLS = 50;\n',
  'const MAX_SKILLS = 50;\nconst activeTaskRuns = new Map();\n',
  "active task runtime map"
);

replaceOnce(
  'case "STOP_TASK": return updateTaskControl(message.taskId, "cancelled");',
  'case "STOP_TASK": return stopTask(message.taskId);',
  "STOP_TASK handler"
);

replaceOnce(
  '  await upsertTask(task);\n\n  try {',
  '  await upsertTask(task);\n  const runtime = { taskId: task.id, cancelled: false, providerController: null };\n  activeTaskRuns.set(task.id, runtime);\n\n  try {',
  "task runtime registration"
);

replaceOnce(
  'const extracted = await extractWithModel(settings, secret, payload.goal, observation);',
  'const extracted = await extractWithModel(settings, secret, payload.goal, observation, runtime);',
  "task-scoped extraction"
);

replaceOnce(
  '    return { ok: false, task: await getTask(task.id), error: serializeError(error) };\n  }\n}\n\nasync function observeTab',
  '    return { ok: false, task: await getTask(task.id), error: serializeError(error) };\n  } finally {\n    activeTaskRuns.delete(task.id);\n  }\n}\n\nasync function observeTab',
  "task runtime cleanup"
);

replaceOnce(
  'async function extractWithModel(settings, secret, goal, observation) {',
  'async function extractWithModel(settings, secret, goal, observation, taskRuntime = null) {',
  "extraction runtime parameter"
);

replaceOnce(
  '  ], { maxTokens: 500 });\n  const content = response.choices?.[0]?.message?.content;',
  '  ], { maxTokens: 500, taskRuntime });\n  const content = response.choices?.[0]?.message?.content;',
  "provider runtime forwarding"
);

replaceOnce(
`  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST", headers, signal: controller.signal,
      body: JSON.stringify({ model: settings.model, messages, temperature: 0, max_tokens: options.maxTokens || 500 })
    });
  } catch (error) {
    if (error?.name === "AbortError") throw coded("PROVIDER_TIMEOUT", "The AI service did not answer within 30 seconds.");
    throw coded("PROVIDER_UNREACHABLE", "BrowserCrew could not reach this AI service. Check that the address is correct and, for local AI, that the server is running.");
  } finally { clearTimeout(timeout); }`,
`  const controller = new AbortController();
  const taskRuntime = options.taskRuntime || null;
  if (taskRuntime?.cancelled) throw coded("TASK_CANCELLED", "The job was stopped. BrowserCrew will not dispatch another AI request.");
  let timedOut = false;
  if (taskRuntime) taskRuntime.providerController = controller;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 30000);
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST", headers, signal: controller.signal,
      body: JSON.stringify({ model: settings.model, messages, temperature: 0, max_tokens: options.maxTokens || 500 })
    });
  } catch (error) {
    if (error?.name === "AbortError" && taskRuntime?.cancelled) {
      throw coded("TASK_CANCELLED", "The job was stopped. BrowserCrew aborted its active AI request and will not start another step.");
    }
    if (error?.name === "AbortError" && timedOut) throw coded("PROVIDER_TIMEOUT", "The AI service did not answer within 30 seconds.");
    throw coded("PROVIDER_UNREACHABLE", "BrowserCrew could not reach this AI service. Check that the address is correct and, for local AI, that the server is running.");
  } finally {
    clearTimeout(timeout);
    if (taskRuntime?.providerController === controller) taskRuntime.providerController = null;
  }`,
  "task-scoped provider abort"
);

replaceOnce(
  'async function updateTaskControl(id, state) { const task = await transition(id, state, state); return { ok: true, task }; }\nasync function assertNotStopped',
  'async function updateTaskControl(id, state) { const task = await transition(id, state, state); return { ok: true, task }; }\nasync function stopTask(id) {\n  const task = await transition(id, "cancelled", "cancelled");\n  const runtime = activeTaskRuns.get(id);\n  if (runtime) {\n    runtime.cancelled = true;\n    runtime.providerController?.abort();\n  }\n  return { ok: true, task };\n}\nasync function assertNotStopped',
  "persist-before-abort Stop"
);

await writeFile(path, source);
console.log("REL-01 background patch applied.");
