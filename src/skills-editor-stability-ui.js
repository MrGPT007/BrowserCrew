const SKILL_CARD_SELECTOR = "#versionedSkillsCard";
const SKILL_LIST_SELECTOR = "#versionedSkillList";
const DRAFT_EDITOR_SELECTOR = "[data-draft-review-editor]";
let stabilizedEditor = null;

window.addEventListener("DOMContentLoaded", () => {
  const card = document.querySelector(SKILL_CARD_SELECTOR);
  const list = document.querySelector(SKILL_LIST_SELECTOR);
  if (!card || !list) return;

  const observer = new MutationObserver(() => stabilizeDraftEditor(card, list));
  observer.observe(card, { childList: true, subtree: true });
  stabilizeDraftEditor(card, list);
});

function stabilizeDraftEditor(card, list) {
  const editor = card.querySelector(DRAFT_EDITOR_SELECTOR);
  if (editor && list.contains(editor)) {
    stabilizedEditor = editor;
    card.append(editor);
    return;
  }

  if (editor) {
    stabilizedEditor = editor;
    return;
  }

  if (!stabilizedEditor) return;
  stabilizedEditor = null;
  queueMicrotask(() => refreshActiveLibraryView(card));
}

function refreshActiveLibraryView(card) {
  const activeFilter = card.querySelector('#skillLibraryFilters [data-skill-filter][aria-pressed="true"]');
  activeFilter?.click();
}
