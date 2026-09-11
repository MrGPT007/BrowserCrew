document.addEventListener("DOMContentLoaded", () => {
  const grid = document.querySelector(".mode-choice-grid");
  if (!grid) return;

  grid.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-job-mode]");
    if (!button || button.dataset.jobMode === "directory") return;
    queueMicrotask(() => {
      for (const selector of ["#directoryJobCard", "#directoryRunCard", "#directoryResultCard"]) {
        const element = document.querySelector(selector);
        if (element) element.hidden = true;
      }
    });
  });
});
