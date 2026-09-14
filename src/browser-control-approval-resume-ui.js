const BROWSER_CONTROL_GRANT_KEY = "browsercrew.browserControlGrant.v1";
const BROWSER_CONTROL_PENDING_APPROVAL_KEY = "browsercrew.browserControlPendingApproval.v1";
const CHAT_PORT = "browsercrew-chat";

installApprovalResumeBridge();
document.addEventListener("DOMContentLoaded", installApprovalResumeBridge);

function installApprovalResumeBridge() {
  const button = document.querySelector("#browserControlApprovalApprove");
  if (!button || button.dataset.resumeBridge === "true") return;
  button.dataset.resumeBridge = "true";
  button.addEventListener("click", approveAndResume, true);
}

async function approveAndResume(event) {
  event.preventDefault();
  event.stopImmediatePropagation();

  const button = event.currentTarget;
  if (button?.dataset.busy === "true") return;
  const dialog = document.querySelector("#browserControlApproval");
  const approvalId = String(dialog?.dataset.approvalId || "");
  const conversationId = String(document.querySelector("#chatConversationSelect")?.value || "");
  if (!approvalId || !conversationId) {
    showResumeNotice("BrowserCrew could not match this approval to its Chat. Cancel it and ask again.");
    return;
  }

  const stored = await chrome.storage.session.get([BROWSER_CONTROL_PENDING_APPROVAL_KEY, BROWSER_CONTROL_GRANT_KEY]).catch(() => ({}));
  const pending = stored[BROWSER_CONTROL_PENDING_APPROVAL_KEY];
  const grant = stored[BROWSER_CONTROL_GRANT_KEY];
  if (!pending?.id || pending.id !== approvalId || !grant?.enabled || grant.id !== pending.grantId) {
    showResumeNotice("That browser approval is no longer current. BrowserCrew did not use it.");
    return;
  }

  button.dataset.busy = "true";
  button.disabled = true;
  button.textContent = "Approving…";
  try {
    const result = await chrome.runtime.sendMessage({ type: "APPROVE_BROWSER_CONTROL_ACTION", approvalId }).catch((error) => ({
      ok: false,
      message: error?.message || "BrowserCrew could not send the approval."
    }));
    if (!result?.ok) {
      showResumeNotice(result?.message || "BrowserCrew did not use that approval.");
      return;
    }

    showResumeNotice("Approved once. BrowserCrew is checking the result and continuing your task.");
    requestChatResume({
      conversationId,
      approvalId,
      grantId: pending.grantId,
      approvedLabel: pending.label,
      approvedUrl: pending.url
    });
  } finally {
    delete button.dataset.busy;
    button.disabled = false;
    button.textContent = "Approve once";
  }
}

function requestChatResume(payload) {
  const port = chrome.runtime.connect({ name: CHAT_PORT });
  let settled = false;
  const close = () => {
    if (settled) return;
    settled = true;
    try { port.disconnect(); } catch {}
  };
  port.onMessage.addListener((message) => {
    if (message?.type === "CHAT_RESUME_ACCEPTED") {
      close();
      return;
    }
    if (message?.type === "CHAT_ERROR") {
      showResumeNotice(message.error?.message || "The approved action finished, but Chat could not resume automatically.");
      close();
    }
  });
  port.onDisconnect.addListener(() => { settled = true; });
  port.postMessage({ type: "RESUME_CHAT_AFTER_BROWSER_APPROVAL", payload });
  setTimeout(close, 2500);
}

function showResumeNotice(message) {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.textContent = String(message || "").slice(0, 500);
  toast.hidden = false;
  clearTimeout(showResumeNotice.timer);
  showResumeNotice.timer = setTimeout(() => { toast.hidden = true; }, 5000);
}
