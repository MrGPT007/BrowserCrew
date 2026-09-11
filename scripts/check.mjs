import { readFile, access } from "node:fs/promises";

const required = [
  "manifest.json", "sidepanel.html", "src/background.js", "src/sidepanel.js",
  "src/styles/neobrutal-soft.css", "src/styles/app.css", "docs/PRD.md",
  "docs/ARCHITECTURE.md", "docs/PERMISSIONS.md", "docs/FEASIBILITY.md", "AGENTS.md"
];

for (const file of required) await access(file);

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
if (manifest.manifest_version !== 3) throw new Error("Manifest must stay on MV3.");
for (const forbidden of ["debugger", "cookies", "nativeMessaging", "downloads"]) {
  if (manifest.permissions?.includes(forbidden)) throw new Error(`Unexpected privileged permission: ${forbidden}`);
}

const background = await readFile("src/background.js", "utf8");
for (const forbidden of ["eval(", "new Function(", "chrome.cookies", "document.cookie"]) {
  if (background.includes(forbidden)) throw new Error(`Forbidden privileged pattern found: ${forbidden}`);
}

const html = await readFile("sidepanel.html", "utf8");
for (const forbiddenCopy of ["Configure settings", "Advanced options", "API endpoint", "Initialize component", "Toggle feature flag"]) {
  if (html.includes(forbiddenCopy)) throw new Error(`Grandma-proof copy violation: ${forbiddenCopy}`);
}

const soft = await readFile("src/styles/neobrutal-soft.css", "utf8");
if (/translate(?:Y)?\(\s*-/i.test(soft)) throw new Error("NeoBrutal Soft violation: interactive surfaces must compress, never float upward.");
if (!soft.includes("prefers-reduced-motion")) throw new Error("Reduced-motion support is required.");
if (!soft.includes(":focus-visible")) throw new Error("Visible keyboard focus is required.");

console.log("BrowserCrew static quality checks passed.");
