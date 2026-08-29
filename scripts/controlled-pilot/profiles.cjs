"use strict";

const registry = require("../controlled-coding-pilot-registry.cjs");

module.exports = {
  DEFINITION_VERSION: registry.DEFINITION_VERSION,
  RUNTIME_BUDGETS: registry.RUNTIME_BUDGETS,
  V2_DEFINITION_VERSION: registry.V2_DEFINITION_VERSION,
  VERIFICATION_STAGES: registry.VERIFICATION_STAGES,
  resolvePilotConfiguration: registry.resolvePilotConfiguration
};
