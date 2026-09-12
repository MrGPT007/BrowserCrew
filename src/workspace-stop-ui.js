document.addEventListener("DOMContentLoaded", () => {
  document.querySelector("#stopButton")?.addEventListener("click", (event) => controlActiveWorkspaceTask(event, "STOP_TASK"), true);
  document.querySelector("#pauseButton")?.addEventListener("click", (event) => controlActiveWorkspaceTask(event, "PAUSE_TASK"), true);
});

async function controlActiveWorkspaceTask(event, type) {
  event.preventDefault();
  event.stopImmediatePropagation();

  const response = await chrome.runtime.sendMessage({ type: "GET_TASKS" }).catch(() => null);
  const tasks = Array.isArray(response?.tasks) ? response.tasks : [];
  const goal = String(document.querySelector("#goalInput")?.value || "").trim();
  const allowed = type === "STOP_TASK" ? new Set(["planning", "running", "paused"]) : new Set(["planning", "running"]);
  const candidates = tasks.filter((task) => !task.kind && allowed.has(task.status));
  const task = candidates.find((item) => goal && item.goal === goal) || candidates[0];

  if (!task) {
    showWorkspaceControlNotice("There is no running read job to control.");
    return;
  }

  const controlled = await chrome.runtime.sendMessage({ type, taskId: task.id }).catch(() => null);
  if (!controlled?.ok) {
    showWorkspaceControlNotice(controlled?.error?.message || "BrowserCrew could not change this job right now.");
    return;
  }

  const stopped = controlled.task?.status === "cancelled";
  const title = document.querySelector("#runTitle");
  const badge = document.querySelector("#runBadge");
  if (title) title.textContent = stopped ? "Job stopped" : "Job paused";
  if (badge) badge.textContent = stopped ? "Stopped" : "Paused";
  showWorkspaceControlNotice(stopped
    ? "Job stopped. The active AI request was cancelled and no new step will start."
    : "Job paused. The current step may finish, but no new step will start.");
}

function showWorkspaceControlNotice(message) {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.hidden = false;
  toast.textContent = message;
  clearTimeout(showWorkspaceControlNotice.timer);
  showWorkspaceControlNotice.timer = setTimeout(() => { toast.hidden = true; }, 4200);
}
