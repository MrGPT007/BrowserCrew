import { createScheduleSkillDispatcher, inspectScheduleSkillReadiness } from "./schedule-dispatcher.js";
import { resolveActiveScheduleGrant } from "./schedule-grants-runtime.js";
import { createScheduleProviderResolver, createScheduleResourceResolver } from "./schedule-resolvers.js";

export function createProductionScheduleExecutionResolvers({ resolveResourceIds = null } = {}) {
  return Object.freeze({
    resolveProvider: createScheduleProviderResolver(),
    resolveGrant: resolveActiveScheduleGrant,
    resolveResource: createScheduleResourceResolver({ resolveResourceIds })
  });
}

export function createProductionScheduleSkillDispatcher({ resolveResourceIds = null } = {}) {
  return createScheduleSkillDispatcher(createProductionScheduleExecutionResolvers({ resolveResourceIds }));
}

export async function inspectProductionScheduleReadiness({ schedule, skill, resolveResourceIds = null } = {}) {
  const resolvers = createProductionScheduleExecutionResolvers({ resolveResourceIds });
  return inspectScheduleSkillReadiness({ schedule, skill, ...resolvers });
}
