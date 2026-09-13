import { validateSkill } from "./skills-contract.js";

export function createNextVersionDraft(source, versions = [], { createdAt } = {}) {
  const original = structuredClone(source || {});
  const initial = validateSkill(original);
  if (!initial.ok) throw new Error(`Cannot version invalid skill: ${initial.errors.join(" ")}`);
  if (!createdAt) throw new Error("Creating a new skill version requires createdAt.");
  if (!original.id) throw new Error("A stable skill id is required for version lineage.");

  const related = [original, ...versions.filter((item) => item?.id === original.id)];
  const highest = related.map((item) => parseVersion(item.version)).filter(Boolean).sort(compareVersion).at(-1) || [0, 0, 0];
  const next = `${highest[0]}.${highest[1]}.${highest[2] + 1}`;
  const draft = structuredClone(original);
  draft.version = next;
  draft.status = "draft";
  delete draft.approval;
  delete draft.archivedAt;
  draft.provenance = {
    source: "skill_version_draft",
    sourceSkillRef: { id: original.id, version: original.version },
    createdAt
  };

  const result = validateSkill(draft);
  if (!result.ok) throw new Error(`New skill version draft is invalid: ${result.errors.join(" ")}`);
  return draft;
}

function parseVersion(value) {
  const match = String(value || "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
}
function compareVersion(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
