const ATTACHMENT_SESSION_KEY = "browsercrew.chatPendingAttachments.v1";
const MAX_FILES = 5;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_CHARS_PER_FILE = 12000;
const MAX_PDF_PAGES = 80;

const attachmentState = { items: [], busy: false };

installAttachmentSurface();
document.addEventListener("DOMContentLoaded", initAttachmentUi);

function installAttachmentSurface() {
  if (document.querySelector("#chatAttachButton")) return;
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "src/styles/chat-attachments.css";
  document.head.append(css);

  const composer = document.querySelector("#chatInput")?.closest(".chat-composer-card");
  const input = document.querySelector("#chatInput");
  if (!composer || !input) return;

  const wrap = document.createElement("div");
  wrap.className = "chat-attachments-wrap";
  wrap.innerHTML = `
    <input id="chatAttachmentInput" type="file" multiple hidden accept=".pdf,.txt,.md,.markdown,.csv,.json,text/plain,text/markdown,text/csv,application/json,application/pdf" />
    <div class="chat-attachment-toolbar">
      <button class="button button-small tactile" id="chatAttachButton" type="button">Attach files</button>
      <span class="chat-attachment-limit">PDF · TXT · Markdown · CSV · JSON</span>
    </div>
    <div class="chat-attachment-list" id="chatAttachmentList" hidden aria-live="polite"></div>
    <p class="helper chat-attachment-note" id="chatAttachmentNote">Files stay on this device until you press Send. BrowserCrew sends only bounded extracted text, not unrestricted file-system access.</p>`;
  input.before(wrap);
}

async function initAttachmentUi() {
  bindAttachmentEvents();
  await restorePendingAttachments();
  updateAttachmentDestination();
  decorateTranscriptAttachments();

  const destination = document.querySelector("#chatDestinationText");
  if (destination) new MutationObserver(updateAttachmentDestination).observe(destination, { childList: true, subtree: true, characterData: true });
  const messages = document.querySelector("#chatMessages");
  if (messages) new MutationObserver(decorateTranscriptAttachments).observe(messages, { childList: true, subtree: true });
}

function bindAttachmentEvents() {
  document.querySelector("#chatAttachButton")?.addEventListener("click", () => {
    if (attachmentState.busy) return;
    document.querySelector("#chatAttachmentInput")?.click();
  });
  document.querySelector("#chatAttachmentInput")?.addEventListener("change", onFilesSelected);
  document.querySelector("#chatAttachmentList")?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-remove-attachment]");
    if (!button) return;
    attachmentState.items = attachmentState.items.filter((item) => item.id !== button.dataset.removeAttachment);
    await persistPendingAttachments();
    renderAttachments();
  });

  document.querySelector("#chatConversationSelect")?.addEventListener("change", clearPendingAttachments);
  document.querySelector("#chatNewButton")?.addEventListener("click", clearPendingAttachments);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes[ATTACHMENT_SESSION_KEY] && !changes[ATTACHMENT_SESSION_KEY].newValue) {
      attachmentState.items = [];
      renderAttachments();
    }
    if (area === "local" && changes["browsercrew.conversations.v1"]) decorateTranscriptAttachments();
  });

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") queueMicrotask(syncAttachCommand);
  }, true);
  document.querySelector("#commandPaletteButton")?.addEventListener("click", () => queueMicrotask(syncAttachCommand));
  document.querySelector("#commandSearch")?.addEventListener("input", () => queueMicrotask(syncAttachCommand));
  document.querySelector("#commandSearch")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const query = String(event.currentTarget.value || "").trim().toLowerCase();
    if (!query || !"attach files document pdf csv json markdown text".includes(query)) return;
    if (!document.querySelector("#attachmentCommandOption")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    document.querySelector("#commandPalette").hidden = true;
    document.querySelector("#chatAttachmentInput")?.click();
  }, true);
}

async function onFilesSelected(event) {
  const input = event.currentTarget;
  const selected = [...(input.files || [])];
  input.value = "";
  if (!selected.length) return;
  if (attachmentState.items.length + selected.length > MAX_FILES) {
    notifyAttachment(`Attach no more than ${MAX_FILES} files to one message.`);
    return;
  }
  const totalBytes = [...attachmentState.items, ...selected].reduce((sum, item) => sum + Number(item.size || 0), 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    notifyAttachment("These files are too large together. Keep the selected files under 16 MB total.");
    return;
  }

  setAttachmentBusy(true, "Reading files…");
  try {
    for (const file of selected) {
      if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is larger than 8 MB. Choose a smaller file.`);
      const item = await extractAttachment(file);
      attachmentState.items.push(item);
    }
    await persistPendingAttachments();
    renderAttachments();
  } catch (error) {
    notifyAttachment(error?.message || "BrowserCrew could not read one of those files.");
  } finally {
    setAttachmentBusy(false, "Attach files");
  }
}

async function extractAttachment(file) {
  const type = attachmentType(file);
  if (!type) throw new Error(`${file.name} is not a supported file type. Use PDF, TXT, Markdown, CSV, or JSON.`);
  const buffer = await file.arrayBuffer();
  const digest = await sha256Hex(new Uint8Array(buffer));
  let extracted;

  if (type === "pdf") extracted = await extractPdfText(buffer, file.name);
  else extracted = extractTextFile(buffer, type, file.name);

  const rawText = String(extracted.text || "").replace(/\u0000/g, "").trim();
  if (!rawText) throw new Error(`${file.name} did not contain readable text.`);
  const truncated = rawText.length > MAX_CHARS_PER_FILE;
  const text = rawText.slice(0, MAX_CHARS_PER_FILE);

  return {
    id: crypto.randomUUID(),
    name: safeFileName(file.name),
    type,
    mediaType: file.type || mediaTypeFor(type),
    size: file.size,
    characters: text.length,
    digest,
    truncated,
    pages: extracted.pages || null,
    text
  };
}

function extractTextFile(buffer, type, name) {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  if (/\u0000/.test(text)) throw new Error(`${name} looks like a binary file. Choose a text-based document instead.`);
  if (type === "json") {
    try {
      const parsed = JSON.parse(text);
      return { text: JSON.stringify(parsed, null, 2) };
    } catch {
      throw new Error(`${name} is not valid JSON. Fix the file or attach it as plain text.`);
    }
  }
  return { text };
}

async function extractPdfText(buffer, name) {
  let pdfjs;
  try {
    pdfjs = await import(chrome.runtime.getURL("node_modules/pdfjs-dist/legacy/build/pdf.mjs"));
  } catch {
    throw new Error("PDF reading is not installed. Run npm install for BrowserCrew, then reload the extension and try again.");
  }

  try {
    pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs");
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useWorkerFetch: false });
    const pdf = await loadingTask.promise;
    if (pdf.numPages > MAX_PDF_PAGES) throw new Error(`${name} has ${pdf.numPages} pages. This build reads up to ${MAX_PDF_PAGES} PDF pages per file.`);
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent({ disableNormalization: false });
      let pageText = "";
      for (const item of content.items || []) {
        if (typeof item?.str !== "string") continue;
        pageText += item.str;
        pageText += item.hasEOL ? "\n" : " ";
      }
      const cleaned = pageText.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      if (cleaned) pages.push(`--- Page ${pageNumber} ---\n${cleaned}`);
      if (pages.join("\n\n").length >= MAX_CHARS_PER_FILE * 2) break;
    }
    await loadingTask.destroy().catch(() => {});
    const text = pages.join("\n\n");
    if (!text) throw new Error(`${name} has no extractable text. Scanned/image-only PDFs need OCR, which is not enabled in this attachment workflow yet.`);
    return { text, pages: pdf.numPages };
  } catch (error) {
    if (/pages|extractable text|OCR/.test(String(error?.message || ""))) throw error;
    throw new Error(`BrowserCrew could not safely read text from ${name}. Try another PDF or export it as text.`);
  }
}

async function persistPendingAttachments() {
  if (!attachmentState.items.length) {
    await chrome.storage.session.remove(ATTACHMENT_SESSION_KEY);
    return;
  }
  const scope = document.querySelector("#chatConversationSelect")?.value || "new";
  await chrome.storage.session.set({
    [ATTACHMENT_SESSION_KEY]: {
      schemaVersion: 1,
      scope,
      selectedAt: new Date().toISOString(),
      items: attachmentState.items
    }
  });
}

async function restorePendingAttachments() {
  const stored = await chrome.storage.session.get(ATTACHMENT_SESSION_KEY);
  const pending = stored[ATTACHMENT_SESSION_KEY];
  if (!pending?.items?.length) return;
  const currentScope = document.querySelector("#chatConversationSelect")?.value || "new";
  if (pending.scope !== "new" && currentScope && pending.scope !== currentScope) {
    await chrome.storage.session.remove(ATTACHMENT_SESSION_KEY);
    return;
  }
  attachmentState.items = pending.items.slice(0, MAX_FILES);
  renderAttachments();
}

async function clearPendingAttachments() {
  if (!attachmentState.items.length) return;
  attachmentState.items = [];
  await chrome.storage.session.remove(ATTACHMENT_SESSION_KEY);
  renderAttachments();
}

function renderAttachments() {
  const list = document.querySelector("#chatAttachmentList");
  if (!list) return;
  list.replaceChildren();
  list.hidden = !attachmentState.items.length;
  for (const item of attachmentState.items) {
    const chip = document.createElement("article");
    chip.className = "chat-attachment-chip";
    chip.innerHTML = `
      <span class="chat-attachment-kind">${escapeHtml(item.type.toUpperCase())}</span>
      <span class="chat-attachment-copy"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(formatBytes(item.size))} · ${item.characters.toLocaleString()} text characters${item.truncated ? " · bounded" : ""}</small></span>
      <button type="button" class="chat-attachment-remove tactile" data-remove-attachment="${escapeAttribute(item.id)}" aria-label="Remove ${escapeAttribute(item.name)}">×</button>`;
    list.append(chip);
  }
  updateAttachmentDestination();
}

function updateAttachmentDestination() {
  const note = document.querySelector("#chatAttachmentNote");
  if (!note) return;
  if (!attachmentState.items.length) {
    note.textContent = "Files stay on this device until you press Send. BrowserCrew sends only bounded extracted text, not unrestricted file-system access.";
    return;
  }
  const destination = String(document.querySelector("#chatDestinationText")?.textContent || "your selected AI").replace(/^Where this message goes:\s*/i, "");
  note.textContent = `${attachmentState.items.length} file${attachmentState.items.length === 1 ? " is" : "s are"} ready. They stay on this device until Send; then the bounded extracted text goes to ${destination}`;
}

async function decorateTranscriptAttachments() {
  const select = document.querySelector("#chatConversationSelect");
  const conversationId = select?.value;
  const list = document.querySelector("#chatMessages");
  if (!conversationId || !list) return;
  const stored = await chrome.storage.local.get("browsercrew.conversations.v1");
  const conversation = (stored["browsercrew.conversations.v1"] || []).find((item) => item.id === conversationId);
  if (!conversation) return;
  const userMessages = (conversation.messages || []).filter((message) => message.role === "user");
  const nodes = [...list.querySelectorAll(".chat-message-user")];
  nodes.forEach((node, index) => {
    node.querySelector(".chat-sent-attachments")?.remove();
    const attachments = userMessages[index]?.context?.attachments;
    if (!Array.isArray(attachments) || !attachments.length) return;
    const wrap = document.createElement("div");
    wrap.className = "chat-sent-attachments";
    wrap.textContent = `Attached: ${attachments.map((item) => item.name).join(", ")}`;
    node.append(wrap);
  });
}

function syncAttachCommand() {
  const palette = document.querySelector("#commandPalette");
  const list = document.querySelector("#commandList");
  const search = document.querySelector("#commandSearch");
  if (!palette || palette.hidden || !list || !search) return;
  document.querySelector("#attachmentCommandOption")?.remove();
  const query = String(search.value || "").trim().toLowerCase();
  const haystack = "attach files document pdf csv json markdown text";
  if (query && !haystack.includes(query)) return;
  const option = document.createElement("button");
  option.id = "attachmentCommandOption";
  option.type = "button";
  option.className = "command-option";
  option.setAttribute("role", "option");
  option.innerHTML = `<span><strong>Attach files</strong><small>Add PDF, TXT, Markdown, CSV, or JSON to the next Chat message.</small></span><kbd>A</kbd>`;
  option.addEventListener("click", () => {
    palette.hidden = true;
    document.querySelector("#chatAttachmentInput")?.click();
  });
  list.append(option);
}

function attachmentType(file) {
  const name = String(file.name || "").toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (file.type === "application/json" || name.endsWith(".json")) return "json";
  if (file.type === "text/csv" || name.endsWith(".csv")) return "csv";
  if (file.type === "text/markdown" || name.endsWith(".md") || name.endsWith(".markdown")) return "markdown";
  if (file.type === "text/plain" || name.endsWith(".txt")) return "txt";
  return null;
}

function mediaTypeFor(type) {
  if (type === "pdf") return "application/pdf";
  if (type === "json") return "application/json";
  if (type === "csv") return "text/csv";
  if (type === "markdown") return "text/markdown";
  return "text/plain";
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function safeFileName(value) {
  return String(value || "Untitled file").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 180) || "Untitled file";
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function setAttachmentBusy(busy, label) {
  attachmentState.busy = busy;
  const button = document.querySelector("#chatAttachButton");
  if (!button) return;
  button.disabled = busy;
  button.textContent = label;
}

function notifyAttachment(message) {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(notifyAttachment.timer);
  notifyAttachment.timer = setTimeout(() => { toast.hidden = true; }, 5000);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function escapeAttribute(value) { return escapeHtml(value); }
