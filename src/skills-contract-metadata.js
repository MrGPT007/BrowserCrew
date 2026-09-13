export const SKILL_CONTRACT_METADATA_VERSION = 1;
export const BROWSERCREW_CONTRACT_VERSION = "0.2.0";

export function migrateSkillContractMetadata(input, { updatedAt } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const skill = structuredClone(input);
  const createdAt = skill.createdAt || skill.provenance?.createdAt || null;

  if (!Object.prototype.hasOwnProperty.call(skill, "allowedResources")) skill.allowedResources = [];
  if (!Object.prototype.hasOwnProperty.call(skill, "providerRequirements")) skill.providerRequirements = { capabilities: [] };
  else if (isPlainObject(skill.providerRequirements) && !Object.prototype.hasOwnProperty.call(skill.providerRequirements, "capabilities")) skill.providerRequirements.capabilities = [];

  if (!Object.prototype.hasOwnProperty.call(skill, "writePolicy")) skill.writePolicy = { approvalRequired: true, noBlindRetry: true };
  if (!Object.prototype.hasOwnProperty.call(skill, "verificationRules")) skill.verificationRules = { reobserveTargetsBeforeDispatch: true, requireFinalVerification: true };

  if (!Object.prototype.hasOwnProperty.call(skill, "createdAt") && createdAt) skill.createdAt = createdAt;
  if (updatedAt) skill.updatedAt = updatedAt;
  else if (!Object.prototype.hasOwnProperty.call(skill, "updatedAt") && createdAt) skill.updatedAt = createdAt;

  if (!Object.prototype.hasOwnProperty.call(skill, "compatibility")) {
    skill.compatibility = { metadataVersion: SKILL_CONTRACT_METADATA_VERSION, minBrowserCrewVersion: BROWSERCREW_CONTRACT_VERSION };
  } else if (isPlainObject(skill.compatibility)) {
    if (!Object.prototype.hasOwnProperty.call(skill.compatibility, "metadataVersion")) skill.compatibility.metadataVersion = SKILL_CONTRACT_METADATA_VERSION;
    if (!Object.prototype.hasOwnProperty.call(skill.compatibility, "minBrowserCrewVersion")) skill.compatibility.minBrowserCrewVersion = BROWSERCREW_CONTRACT_VERSION;
  }
  return skill;
}

export function hasCompleteSkillContractMetadata(skill) {
  return Boolean(
    skill &&
    Array.isArray(skill.allowedResources) &&
    isPlainObject(skill.providerRequirements) && Array.isArray(skill.providerRequirements.capabilities) &&
    isPlainObject(skill.writePolicy) &&
    isPlainObject(skill.verificationRules) &&
    typeof skill.createdAt === "string" &&
    typeof skill.updatedAt === "string" &&
    isPlainObject(skill.compatibility)
  );
}

export function assertSkillCompatibility(skill, currentVersion = BROWSERCREW_CONTRACT_VERSION) {
  const effective = migrateSkillContractMetadata(skill);
  const minimum = effective?.compatibility?.minBrowserCrewVersion;
  if (!isSemver(minimum)) throw coded("SKILL_COMPATIBILITY_INVALID", "This Skill has invalid compatibility metadata.");
  if (!isSemver(currentVersion)) throw coded("BROWSERCREW_VERSION_INVALID", "BrowserCrew could not check Skill compatibility safely.");
  if (compareSemver(currentVersion, minimum) < 0) throw coded("SKILL_REQUIRES_NEWER_BROWSERCREW", `This Skill requires BrowserCrew ${minimum} or newer.`);
  return true;
}

export function assertSkillMetadataGrantCoversRequirements(skill, grant = {}) {
  const effective = migrateSkillContractMetadata(skill);
  const resources = new Set(grant?.resources || []);
  const providerCapabilities = new Set(grant?.providerCapabilities || []);
  for (const resource of effective.allowedResources || []) {
    if (!resources.has(resource)) throw coded("SKILL_RESOURCE_NOT_GRANTED", `This run is missing access to the reviewed resource ${resource}.`);
  }
  for (const capability of effective.providerRequirements?.capabilities || []) {
    if (!providerCapabilities.has(capability)) throw coded("SKILL_PROVIDER_CAPABILITY_NOT_GRANTED", `This run needs the reviewed provider capability ${capability}.`);
  }
  return true;
}

function compareSemver(a, b) {
  const av = String(a).split(".").map(Number);
  const bv = String(b).split(".").map(Number);
  return (av[0] || 0) - (bv[0] || 0) || (av[1] || 0) - (bv[1] || 0) || (av[2] || 0) - (bv[2] || 0);
}
function isSemver(value) { return /^\d+\.\d+\.\d+$/.test(String(value || "")); }
function isPlainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function coded(code, message) { const error = new Error(message); error.code = code; return error; }
