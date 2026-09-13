const CONNECTIONS_KEY = "browsercrew.connections.v1";

export function createScheduleProviderResolver({ readConnections = defaultReadConnections } = {}) {
  if (typeof readConnections !== "function") throw coded("SCHEDULE_PROVIDER_STORE_REQUIRED", "Scheduled provider resolution needs the durable named-connection store.");
  return async function resolveScheduleProvider(providerRef) {
    if (!providerRef) throw coded("SCHEDULE_PROVIDER_REQUIRED", "This schedule has no named AI connection.");
    const connections = await readConnections();
    const profile = connections.find((item) => item?.id === providerRef);
    if (!profile) throw coded("SCHEDULE_PROVIDER_UNAVAILABLE", "The named AI connection for this schedule no longer exists.");
    const capabilities = Array.isArray(profile.capabilities)
      ? [...new Set(profile.capabilities.filter((item) => typeof item === "string" && item.trim()))]
      : [];
    return {
      id: profile.id,
      available: profile.status === "connected",
      capabilities,
      kind: profile.kind || null,
      model: profile.model || null,
      lastTestedAt: profile.lastTestedAt || null
    };
  };
}

export function createScheduleResourceResolver({ resolveResourceIds = null, containsOriginPermission = defaultContainsOriginPermission, listTabs = defaultListTabs } = {}) {
  if (typeof containsOriginPermission !== "function") throw coded("SCHEDULE_PERMISSION_RESOLVER_REQUIRED", "Scheduled resource resolution needs Chrome site-permission checks.");
  if (typeof listTabs !== "function") throw coded("SCHEDULE_TAB_RESOLVER_REQUIRED", "Scheduled resource resolution needs access to the browser tab list.");
  if (resolveResourceIds !== null && typeof resolveResourceIds !== "function") throw coded("SCHEDULE_RESOURCE_ID_RESOLVER_INVALID", "The resource-ID resolver must be a function when provided.");

  return async function resolveScheduleResource({ schedule, skill } = {}) {
    const reviewedUrl = schedule?.startResource?.url;
    if (!reviewedUrl || schedule?.startResource?.kind !== "exact_url") throw coded("SCHEDULE_BINDING_REQUIRED", "Review an exact starting page before BrowserCrew can resolve this schedule.");
    let parsed;
    try { parsed = new URL(reviewedUrl); }
    catch { throw coded("SCHEDULE_RESOURCE_STALE", "The reviewed starting page URL is no longer valid."); }
    if (!/^https?:$/.test(parsed.protocol)) throw coded("SCHEDULE_RESOURCE_STALE", "The reviewed starting page must still be a normal website URL.");
    if (!(skill?.allowedOrigins || []).includes(parsed.origin)) throw coded("SCHEDULE_RESOURCE_OUT_OF_SCOPE", "The reviewed starting page is outside this Skill's approved site scope.");

    const permissionPattern = `${parsed.origin}/*`;
    if (!(await containsOriginPermission(permissionPattern))) {
      throw coded("SCHEDULE_SITE_PERMISSION_REQUIRED", "Chrome site access for this reviewed starting page is missing. Review site access before scheduling can be activated.");
    }

    const tabs = await listTabs();
    const matches = (Array.isArray(tabs) ? tabs : []).filter((tab) => Number.isInteger(tab?.id) && tab?.url === reviewedUrl);
    if (matches.length !== 1) {
      throw coded(matches.length ? "SCHEDULE_RESOURCE_AMBIGUOUS" : "SCHEDULE_RESOURCE_STALE", matches.length
        ? "More than one open tab exactly matches the reviewed starting page. BrowserCrew will not choose one blindly."
        : "BrowserCrew could not re-find the exact reviewed starting page in an open tab.");
    }

    const expectedResources = [...(schedule?.startResource?.expectedResources || [])];
    let resources = [];
    if (expectedResources.length) {
      if (typeof resolveResourceIds !== "function") {
        throw coded("SCHEDULE_RESOURCE_ID_RESOLVER_REQUIRED", "This schedule depends on reviewed resource identities that BrowserCrew cannot safely re-resolve yet.");
      }
      const resolved = await resolveResourceIds({ schedule, skill, tab: structuredClone(matches[0]), expectedResources });
      resources = Array.isArray(resolved) ? [...new Set(resolved.filter((item) => typeof item === "string" && item.trim()))] : [];
    }

    return {
      fresh: true,
      tabId: matches[0].id,
      url: reviewedUrl,
      resources,
      title: String(matches[0].title || "").slice(0, 160)
    };
  };
}

async function defaultReadConnections() {
  const data = await chrome.storage.local.get(CONNECTIONS_KEY);
  return Array.isArray(data[CONNECTIONS_KEY]) ? data[CONNECTIONS_KEY] : [];
}

async function defaultContainsOriginPermission(originPattern) {
  if (!chrome.permissions?.contains) return false;
  return chrome.permissions.contains({ origins: [originPattern] });
}

async function defaultListTabs() {
  if (!chrome.tabs?.query) return [];
  return chrome.tabs.query({});
}

function coded(code, message) { const error = new Error(message); error.code = code; return error; }
