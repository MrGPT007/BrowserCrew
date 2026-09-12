import { access, readFile } from "node:fs/promises";

const requiredFiles = [
  "manifest.json",
  "package.json",
  "package-lock.json",
  "docs/PERMISSIONS.md",
  "docs/PRIVACY-POLICY-v0.2.md",
  "docs/CHROME-WEB-STORE-v0.2.md",
  "docs/RELEASE-EVIDENCE-v0.2.md",
  "store/chrome-web-store-v0.2.json",
  "src/connections-runtime.js"
];
for (const file of requiredFiles) await access(file);

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const contract = JSON.parse(await readFile("store/chrome-web-store-v0.2.json", "utf8"));
const permissionsDoc = await readFile("docs/PERMISSIONS.md", "utf8");
const privacy = await readFile("docs/PRIVACY-POLICY-v0.2.md", "utf8");
const storeDoc = await readFile("docs/CHROME-WEB-STORE-v0.2.md", "utf8");
const evidence = await readFile("docs/RELEASE-EVIDENCE-v0.2.md", "utf8");
const connections = await readFile("src/connections-runtime.js", "utf8");

if (contract.schemaVersion !== 1 || contract.release !== "v0.2") throw new Error("Chrome Web Store contract identity changed.");
if (contract.submissionStatus !== "prepared_not_submitted") throw new Error("B08 must not claim store submission before external evidence exists.");

const singlePurpose = "BrowserCrew lets users run user-approved AI-assisted tasks on browser pages they choose, using AI services they configure, while keeping page access and browser actions under explicit user control.";
if (contract.singlePurpose !== singlePurpose) throw new Error("Store contract single purpose changed without review.");
if (!storeDoc.includes(`**${singlePurpose}**`)) throw new Error("Chrome Web Store submission pack must repeat the exact single-purpose statement.");

const expectedPermissions = ["sidePanel", "storage", "activeTab", "scripting", "tabs", "downloads"];
if (JSON.stringify(manifest.permissions) !== JSON.stringify(expectedPermissions)) {
  throw new Error(`Manifest permissions drifted from the reviewed B08 set: ${JSON.stringify(manifest.permissions)}`);
}
const contractPermissions = contract.manifestPermissions?.map((entry) => entry.name);
if (JSON.stringify(contractPermissions) !== JSON.stringify(expectedPermissions)) throw new Error("Store contract permission list must exactly match manifest.json.");
for (const entry of contract.manifestPermissions || []) {
  if (!entry.justification || !entry.boundary) throw new Error(`Permission ${entry.name} needs both a store justification and a user-visible boundary.`);
  if (!permissionsDoc.includes(`\`${entry.name}\``)) throw new Error(`docs/PERMISSIONS.md is missing ${entry.name}.`);
  if (!storeDoc.includes(`### \`${entry.name}\``)) throw new Error(`Store submission pack is missing a Dashboard justification for ${entry.name}.`);
}

if (Object.prototype.hasOwnProperty.call(manifest, "host_permissions")) throw new Error("B08 forbids blanket install-time host_permissions for v0.2.");
const expectedOptionalHosts = ["https://*/*", "http://*/*"];
if (JSON.stringify(manifest.optional_host_permissions) !== JSON.stringify(expectedOptionalHosts)) throw new Error("Optional host permission patterns changed without B08 review.");
const contractHosts = contract.optionalHostPermissions?.map((entry) => entry.pattern);
if (JSON.stringify(contractHosts) !== JSON.stringify(expectedOptionalHosts)) throw new Error("Store contract optional host permissions must exactly match manifest.json.");
for (const host of contract.optionalHostPermissions || []) {
  if (host.grantModel !== "optional_runtime_origin" || !host.justification) throw new Error(`Optional host ${host.pattern} must remain runtime-granted and justified.`);
}

if (manifest.manifest_version !== 3) throw new Error("Chrome Web Store v0.2 candidate must remain Manifest V3.");
if (manifest.version !== "0.2.0" || pkg.version !== "0.2.0" || lock.version !== "0.2.0" || lock.packages?.[""]?.version !== "0.2.0") {
  throw new Error("Manifest, package.json, and package-lock.json must identify the v0.2 candidate as version 0.2.0.");
}
if (manifest.name !== contract.listing?.name) throw new Error("Store listing name must match manifest name.");
if (!manifest.description || manifest.description.length > 132) throw new Error("Manifest description must be non-empty and at most 132 characters.");
if (!contract.listing?.shortDescription || contract.listing.shortDescription.length > 132) throw new Error("Store short description must be non-empty and at most 132 characters.");
if (contract.listing.category !== "Productivity" || contract.listing.language !== "en") throw new Error("Reviewed v0.2 listing category/language changed.");

const requiredDataCategories = [
  "website_content",
  "personal_communications",
  "authentication_information",
  "personally_identifiable_information",
  "financial_and_payment_information",
  "user_activity"
];
const dataCategories = contract.userData?.categories || [];
for (const id of requiredDataCategories) {
  const entry = dataCategories.find((item) => item.id === id);
  if (!entry?.handled || !entry.purpose || !entry.storage || !Array.isArray(entry.destinations)) throw new Error(`User-data disclosure ${id} is incomplete.`);
}
if (contract.userData?.developerOperatedBackend !== false) throw new Error("v0.2 store contract must not invent a BrowserCrew-operated backend.");
for (const prohibited of ["sale of user data", "personalized advertising", "retargeting", "unrelated analytics or profiling"]) {
  if (!contract.userData?.prohibitedUses?.includes(prohibited)) throw new Error(`Limited Use prohibition missing: ${prohibited}`);
}

if (!connections.includes('const SECRETS_KEY = "browsercrew.connectionSecrets.v1"')) throw new Error("AI credential storage contract key changed.");
if (!connections.includes("chrome.storage.session.get")) throw new Error("AI credentials must remain backed by chrome.storage.session.");
if (!connections.includes("chrome.storage.session.set")) throw new Error("AI credentials must remain written to chrome.storage.session.");
if (!connections.includes("Cloud AI connections must use HTTPS")) throw new Error("Cloud provider HTTPS boundary must remain explicit.");

for (const phrase of [
  "BrowserCrew v0.2 does not use a BrowserCrew-operated cloud backend.",
  "Provider credentials are kept in `chrome.storage.session`",
  "does **not** use or transfer handled user data for",
  "personalized, retargeted, or interest-based advertising",
  "does not download or execute remote JavaScript or WebAssembly",
  "broad HTTP/HTTPS host patterns only as **optional host permissions**"
]) if (!privacy.includes(phrase)) throw new Error(`Privacy policy missing reviewed disclosure: ${phrase}`);

if (contract.remoteCode?.used !== false) throw new Error("v0.2 must not claim or introduce remote hosted code.");
if (!storeDoc.includes("Answer **No**. BrowserCrew does not fetch and execute remote JavaScript or WebAssembly.")) throw new Error("Store remote-code answer must remain explicit.");

const requiredAssets = contract.requiredStoreAssets?.filter((asset) => asset.required) || [];
if (!requiredAssets.length) throw new Error("Store contract must track required listing assets.");
for (const asset of requiredAssets) {
  if (!["missing", "ready"].includes(asset.status)) throw new Error(`Required store asset ${asset.id} has an unsupported status.`);
  if (!asset.spec) throw new Error(`Required store asset ${asset.id} needs an exact spec.`);
}

for (const phrase of [
  "Status: **NOT READY FOR v0.2 RELEASE**",
  "`V02-B08`",
  "Chrome Web Store",
  "Blocked",
  "#50"
]) if (!evidence.includes(phrase)) throw new Error(`Release ledger must keep B08 truthfully blocked and traceable: ${phrase}`);
if (evidence.includes("`V02-B08` — **Resolved")) throw new Error("B08 cannot be resolved by repository preparation alone.");

if (pkg.scripts?.["store-readiness-check"] !== "node scripts/store-readiness-check.mjs") throw new Error("store-readiness-check must stay wired in package.json.");
if (!String(pkg.scripts?.check || "").includes("store-readiness-check.mjs")) throw new Error("npm run check must enforce Chrome Web Store readiness contracts.");

console.log("BrowserCrew V02-B08 Chrome Web Store readiness contracts passed (engineering only; not submitted).\n");
