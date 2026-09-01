"use strict";

const TASK_CLASS_REGISTRY_VERSION = "gate6-task-classes/v1";

class Gate6TaskClassRegistryError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "Gate6TaskClassRegistryError";
    this.code = code;
  }
}

function fail(code, detail) {
  throw new Gate6TaskClassRegistryError(code, detail);
}

function defineTaskClass(definition) {
  const requiredFields = [
    "id",
    "version",
    "requiresImplementationFile",
    "requiresTestFile",
    "allowsNoChange",
    "allowsCrossFileExpansion"
  ];
  const booleanFields = [
    "requiresImplementationFile",
    "requiresTestFile",
    "allowsNoChange",
    "allowsCrossFileExpansion"
  ];

  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    fail("GATE6_TASK_CLASS_DEFINITION_INVALID");
  }
  if (JSON.stringify(Object.keys(definition).sort()) !== JSON.stringify([...requiredFields].sort())) {
    fail("GATE6_TASK_CLASS_DEFINITION_INVALID", String(definition.id ?? "unknown"));
  }
  if (typeof definition.id !== "string" || !/^[a-z][a-z0-9_]*$/.test(definition.id)) {
    fail("GATE6_TASK_CLASS_ID_INVALID", String(definition.id));
  }
  if (!Number.isInteger(definition.version) || definition.version < 1) {
    fail("GATE6_TASK_CLASS_VERSION_INVALID", definition.id);
  }
  for (const field of booleanFields) {
    if (typeof definition[field] !== "boolean") {
      fail("GATE6_TASK_CLASS_METADATA_INVALID", `${definition.id}.${field}`);
    }
  }

  return Object.freeze({ ...definition });
}

const DEFINITIONS = [
  {
    id: "bugfix_with_regression",
    version: 1,
    requiresImplementationFile: true,
    requiresTestFile: true,
    allowsNoChange: false,
    allowsCrossFileExpansion: false
  },
  {
    id: "cross_file_change",
    version: 1,
    requiresImplementationFile: true,
    requiresTestFile: false,
    allowsNoChange: false,
    allowsCrossFileExpansion: true
  },
  {
    id: "dependency_following",
    version: 1,
    requiresImplementationFile: true,
    requiresTestFile: false,
    allowsNoChange: false,
    allowsCrossFileExpansion: true
  },
  {
    id: "api_contract_change",
    version: 1,
    requiresImplementationFile: true,
    requiresTestFile: true,
    allowsNoChange: false,
    allowsCrossFileExpansion: true
  },
  {
    id: "decoy_file_selection",
    version: 1,
    requiresImplementationFile: true,
    requiresTestFile: false,
    allowsNoChange: false,
    allowsCrossFileExpansion: false
  },
  {
    id: "no_change_needed",
    version: 1,
    requiresImplementationFile: false,
    requiresTestFile: false,
    allowsNoChange: true,
    allowsCrossFileExpansion: false
  },
  {
    id: "boundary_sensitive_change",
    version: 1,
    requiresImplementationFile: true,
    requiresTestFile: false,
    allowsNoChange: false,
    allowsCrossFileExpansion: false
  }
].map(defineTaskClass);

const registryEntries = [];
const seenIds = new Set();
for (const definition of DEFINITIONS) {
  if (seenIds.has(definition.id)) fail("GATE6_TASK_CLASS_DUPLICATE_ID", definition.id);
  seenIds.add(definition.id);
  registryEntries.push([definition.id, definition]);
}

const TASK_CLASS_REGISTRY = Object.freeze(Object.fromEntries(registryEntries));
const TASK_CLASS_IDS = Object.freeze(DEFINITIONS.map((definition) => definition.id));

function hasGate6TaskClass(taskClass) {
  return typeof taskClass === "string" &&
    Object.prototype.hasOwnProperty.call(TASK_CLASS_REGISTRY, taskClass);
}

function getGate6TaskClass(taskClass) {
  if (!hasGate6TaskClass(taskClass)) {
    fail("GATE6_TASK_CLASS_UNSUPPORTED", String(taskClass));
  }
  return TASK_CLASS_REGISTRY[taskClass];
}

module.exports = {
  Gate6TaskClassRegistryError,
  TASK_CLASS_IDS,
  TASK_CLASS_REGISTRY,
  TASK_CLASS_REGISTRY_VERSION,
  getGate6TaskClass,
  hasGate6TaskClass
};
