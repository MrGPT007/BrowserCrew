const openModals = new Set();
const modalReturnFocus = new Map();
let lastOutsideFocus = null;

installAccessibilityLayer();
document.addEventListener("DOMContentLoaded", syncAccessibilityState, { once: true });

function installAccessibilityLayer() {
  document.addEventListener("focusin", rememberOutsideFocus, true);
  document.addEventListener("keydown", onAccessibilityKeydown, true);
  const observer = new MutationObserver(() => syncAccessibilityState());
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["hidden", "aria-checked", "aria-selected"]
  });
  syncAccessibilityState();
}

function syncAccessibilityState() {
  syncStatusRegions();
  syncRadioGroups();
  syncCommandPaletteSemantics();
  syncModalState();
}

function syncStatusRegions() {
  for (const id of ["chatRunStatus", "c5Status", "connectionResult"]) {
    const node = document.getElementById(id);
    if (!node) continue;
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    node.setAttribute("aria-atomic", "true");
  }
}

function syncRadioGroups() {
  for (const group of document.querySelectorAll('[role="radiogroup"]')) {
    const radios = [...group.querySelectorAll('[role="radio"]')].filter((radio) => !radio.disabled);
    if (!radios.length) continue;
    const selected = radios.find((radio) => radio.getAttribute("aria-checked") === "true") || radios[0];
    for (const radio of radios) radio.tabIndex = radio === selected ? 0 : -1;
  }
}

function syncCommandPaletteSemantics() {
  const palette = document.getElementById("commandPalette");
  const search = document.getElementById("commandSearch");
  const list = document.getElementById("commandList");
  if (!palette || !search || !list) return;

  search.setAttribute("role", "combobox");
  search.setAttribute("aria-autocomplete", "list");
  search.setAttribute("aria-controls", "commandList");
  search.setAttribute("aria-haspopup", "listbox");
  search.setAttribute("aria-expanded", String(!palette.hidden));

  const options = [...list.querySelectorAll('[role="option"]')];
  options.forEach((option, index) => {
    if (!option.id) option.id = `command-option-${index}`;
  });
  const active = options.find((option) => option.getAttribute("aria-selected") === "true" && !option.disabled);
  if (active) search.setAttribute("aria-activedescendant", active.id);
  else search.removeAttribute("aria-activedescendant");
}

function rememberOutsideFocus(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (!visibleModal()?.contains(target)) lastOutsideFocus = target;
}

function onAccessibilityKeydown(event) {
  const radio = event.target?.closest?.('[role="radio"]');
  if (radio && radio.closest('[role="radiogroup"]')) {
    if (handleRadioKeydown(event, radio)) return;
  }

  const dialog = visibleModal();
  if (!dialog) return;

  if (event.key === "Escape" && dialog.closest("#connectionTransferReview")) {
    event.preventDefault();
    event.stopPropagation();
    document.getElementById("cancelConnectionSwitchButton")?.click();
    return;
  }

  if (event.key !== "Tab") return;
  trapModalTab(event, dialog);
}

function handleRadioKeydown(event, current) {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return false;
  const group = current.closest('[role="radiogroup"]');
  const radios = [...group.querySelectorAll('[role="radio"]')].filter((radio) => !radio.disabled);
  if (!radios.length) return false;
  const index = Math.max(0, radios.indexOf(current));
  let next = index;
  if (["ArrowRight", "ArrowDown"].includes(event.key)) next = (index + 1) % radios.length;
  if (["ArrowLeft", "ArrowUp"].includes(event.key)) next = (index - 1 + radios.length) % radios.length;
  if (event.key === "Home") next = 0;
  if (event.key === "End") next = radios.length - 1;
  event.preventDefault();
  event.stopPropagation();
  radios[next].focus();
  radios[next].click();
  syncRadioGroups();
  return true;
}

function trapModalTab(event, dialog) {
  const focusable = modalFocusable(dialog);
  if (!focusable.length) {
    event.preventDefault();
    dialog.tabIndex = -1;
    dialog.focus();
    return;
  }
  const active = document.activeElement;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (active === first || !dialog.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

function modalFocusable(dialog) {
  const selector = [
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "a[href]",
    '[tabindex]:not([tabindex="-1"])'
  ].join(",");
  return [...dialog.querySelectorAll(selector)].filter((node) => {
    if (!(node instanceof HTMLElement)) return false;
    if (node.hidden || node.closest("[hidden]")) return false;
    const style = getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

function visibleModal() {
  const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].filter((dialog) => {
    if (dialog.hidden || dialog.closest("[hidden]")) return false;
    const style = getComputedStyle(dialog);
    return style.display !== "none" && style.visibility !== "hidden";
  });
  return dialogs.at(-1) || null;
}

function syncModalState() {
  const visible = new Set([...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].filter((dialog) => !dialog.hidden && !dialog.closest("[hidden]")));

  for (const dialog of visible) {
    if (!openModals.has(dialog)) {
      const fallback = document.activeElement instanceof HTMLElement && !dialog.contains(document.activeElement)
        ? document.activeElement
        : lastOutsideFocus;
      if (fallback instanceof HTMLElement) modalReturnFocus.set(dialog, fallback);
      openModals.add(dialog);
    }
  }

  const closed = [...openModals].filter((dialog) => !visible.has(dialog));
  for (const dialog of closed) openModals.delete(dialog);

  const app = document.getElementById("app");
  if (app) app.inert = visible.size > 0;

  if (!visible.size && closed.length) {
    const returnTarget = [...closed].reverse().map((dialog) => modalReturnFocus.get(dialog)).find((target) => target?.isConnected);
    closed.forEach((dialog) => modalReturnFocus.delete(dialog));
    if (returnTarget instanceof HTMLElement && !returnTarget.hidden && !returnTarget.closest("[hidden]")) {
      queueMicrotask(() => returnTarget.focus());
    }
  }
}