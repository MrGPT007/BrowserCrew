import { validateSkill } from "./skills-contract.js";
import { migrateSkillContractMetadata } from "./skills-contract-metadata.js";

export function duplicateSkillAsDraft(source, { id, title, createdAt } = {}) {
  const original = structuredClone(source || {});
  const initial = validateSkill(original);
  if (!initial.ok) throw new Error(`Cannot duplicate invalid skill version: ${initial.errors.join(" ")}`);
  if (!id || !createdAt) throw new Error("Duplicating a skill requires a new id and createdAt timestamp.");

  const duplicate = structuredClone(original);
  duplicate.id = id;
  duplicate.version = "0.1.0";
  duplicate.status = "draft";
  duplicate.title = normalizeTitle(title || `${original.title} copy`);
  delete duplicate.approval;
  delete duplicate.archivedAt;
  delete duplicate.createdAt;
  delete duplicate.updatedAt;
  duplicate.provenance = {
    source: "skill_duplicate",
    sourceSkillRef: { id: original.id, version: original.version },
    createdAt
  };

  const complete = migrateSkillContractMetadata(duplicate, { updatedAt: createdAt });
  const result = validateSkill(complete, { requireMetadata: true });
  if (!result.ok) throw new Error(`Duplicated skill draft is invalid: ${result.errors.join(" ")}`);
  return complete;
}

function normalizeTitle(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) throw new Error("Duplicated skill title cannot be empty.");
  return text.slice(0, 120);
}
