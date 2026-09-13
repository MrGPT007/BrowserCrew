export function installWatchPageRecorder() {
  const KEY = "__browserCrewWatchRecorderV1";
  const existing = globalThis[KEY];
  if (existing?.active) {
    existing.ensureConnected?.();
    return;
  }

  const recorder = {
    active: true,
    port: null,
    ready: false,
    reconnectTimer: null,
    reconnectAttempt: 0,
    sessionId: null,
    pending: [],
    ensureConnected: null,
    stop: null
  };
  globalThis[KEY] = recorder;

  const clean = (value, max = 180) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
  const inferRole = (element) => {
    const tag = element.tagName?.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a") return "link";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (["checkbox", "radio"].includes(type)) return type;
      if (["button", "submit", "reset"].includes(type)) return "button";
      return "textbox";
    }
    return "";
  };
  const describe = (element) => {
    if (!(element instanceof Element)) return {};
    const labelElement = element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`) : null;
    return {
      role: clean(element.getAttribute("role") || inferRole(element), 80),
      label: clean(element.getAttribute("aria-label") || labelElement?.innerText || element.innerText || element.getAttribute("title") || element.getAttribute("placeholder"), 160),
      ariaLabel: clean(element.getAttribute("aria-label"), 160),
      name: clean(element.getAttribute("name"), 120),
      id: clean(element.id, 120),
      testId: clean(element.getAttribute("data-testid"), 120),
      type: clean(element.getAttribute("type"), 40),
      autocomplete: clean(element.getAttribute("autocomplete"), 80),
      placeholder: clean(element.getAttribute("placeholder"), 160)
    };
  };
  const envelope = (event) => ({ type: "event", event: { ...event, origin: location.origin, pageUrl: location.href, occurredAt: new Date().toISOString() } });
  const queue = (message) => {
    recorder.pending.push(message);
    if (recorder.pending.length > 20) recorder.pending.splice(0, recorder.pending.length - 20);
  };
  const scheduleReconnect = () => {
    if (!recorder.active || recorder.reconnectTimer || recorder.port) return;
    const delay = Math.min(250 * (2 ** Math.min(recorder.reconnectAttempt, 3)), 2000);
    recorder.reconnectAttempt += 1;
    recorder.reconnectTimer = setTimeout(() => {
      recorder.reconnectTimer = null;
      connect();
    }, delay);
  };
  const flush = () => {
    if (!recorder.active || !recorder.port || !recorder.ready) return;
    while (recorder.pending.length) {
      const message = recorder.pending[0];
      try {
        recorder.port.postMessage(message);
        recorder.pending.shift();
      } catch {
        recorder.ready = false;
        try { recorder.port.disconnect(); } catch {}
        recorder.port = null;
        scheduleReconnect();
        return;
      }
    }
  };
  const connect = () => {
    if (!recorder.active || recorder.port) return;
    try {
      const port = chrome.runtime.connect({ name: "browsercrew-watch-events" });
      recorder.port = port;
      recorder.ready = false;
      port.onMessage.addListener((message) => {
        if (message?.type !== "watch-session") return;
        if (message.active !== true) {
          recorder.pending.length = 0;
          recorder.stop?.();
          return;
        }
        if (recorder.sessionId && message.sessionId && recorder.sessionId !== message.sessionId) recorder.pending.length = 0;
        recorder.sessionId = message.sessionId || recorder.sessionId;
        recorder.reconnectAttempt = 0;
        recorder.ready = true;
        flush();
      });
      port.onDisconnect.addListener(() => {
        if (recorder.port !== port) return;
        recorder.port = null;
        recorder.ready = false;
        if (recorder.active) scheduleReconnect();
      });
    } catch {
      recorder.port = null;
      recorder.ready = false;
      scheduleReconnect();
    }
  };
  const send = (event) => {
    if (!recorder.active) return;
    const message = envelope(event);
    if (!recorder.port || !recorder.ready) {
      queue(message);
      connect();
      return;
    }
    try {
      recorder.port.postMessage(message);
    } catch {
      queue(message);
      recorder.ready = false;
      try { recorder.port.disconnect(); } catch {}
      recorder.port = null;
      scheduleReconnect();
    }
  };
  const editable = (element) => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || element?.isContentEditable;
  const onClick = (event) => {
    const download = event.target?.closest?.("a[download]");
    if (download instanceof HTMLAnchorElement) {
      const target = describe(download);
      let downloadOrigin = "";
      try { downloadOrigin = new URL(download.href, location.href).origin; } catch {}
      send({ kind: "download", target, downloadOrigin });
      return;
    }
    const target = event.target?.closest?.("button,a,[role='button'],[role='link'],input,select,textarea,[contenteditable='true']") || event.target;
    if (!(target instanceof Element) || editable(target)) return;
    const description = describe(target);
    if (!description.role && !description.label && !description.id && !description.testId) return;
    send({ kind: "click", target: description });
  };
  const onChange = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target instanceof HTMLInputElement && (target.type || "").toLowerCase() === "hidden") return;
    const description = describe(target);
    if (target instanceof HTMLSelectElement) {
      send({ kind: "select", target: description, variableName: clean(target.name || target.id || "selection", 60) });
      return;
    }
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable) {
      send({ kind: "type", target: description, variableName: clean(target.getAttribute("name") || target.id || target.getAttribute("aria-label") || "input", 60) });
    }
  };

  document.addEventListener("click", onClick, true);
  document.addEventListener("change", onChange, true);
  recorder.ensureConnected = connect;
  recorder.stop = () => {
    if (!recorder.active) return;
    recorder.active = false;
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("change", onChange, true);
    if (recorder.reconnectTimer) clearTimeout(recorder.reconnectTimer);
    recorder.reconnectTimer = null;
    recorder.pending.length = 0;
    recorder.ready = false;
    try { recorder.port?.disconnect(); } catch {}
    recorder.port = null;
  };
  connect();
}

export function stopWatchPageRecorder() {
  try { globalThis.__browserCrewWatchRecorderV1?.stop?.(); } catch {}
}
