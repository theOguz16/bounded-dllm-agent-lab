"use strict";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const TEXT_EDIT_PROTOCOL = deepFreeze({
  schemaVersion: "bounded.controlled-text-edits/v1",
  limits: {
    maxEdits: 8,
    maxTotalUtf8Bytes: 20_000
  },
  resolution: {
    source: "original_supplied_source",
    occurrence: "exact_unique",
    overlap: "reject",
    duplicateSpan: "reject"
  },
  materialization: {
    order: "descending_original_start_offset"
  },
  authority: {
    requiredPathOnly: true,
    requiredSourceAuthority: "change_allowed",
    expectedContentHashBinds: "original_source_content"
  },
  invariants: [
    {
      id: "original-source-grounded",
      rule: "Every oldText MUST refer to the original supplied source content identified by expectedContentHash."
    },
    {
      id: "hash-bound",
      rule: "expectedContentHash MUST equal the matching original source contentHash, and that contentHash MUST match the supplied source bytes."
    },
    {
      id: "exact-unique-occurrence",
      rule: "Each oldText MUST occur exactly once in the original supplied full source before any replacement is applied."
    },
    {
      id: "non-overlapping",
      rule: "Edits for the same file MUST resolve to distinct, non-overlapping spans in the original supplied source; duplicate spans are forbidden."
    },
    {
      id: "deterministic-application",
      rule: "All edit spans are resolved against the original source before any replacement is applied, then materialized in descending original start-offset order."
    },
    {
      id: "no-generated-text-chaining",
      rule: "Edits do not grant authority over text introduced by other edits in the same response; generated text MUST NOT be used as oldText evidence."
    },
    {
      id: "bounded-edit-count",
      rule: "A response MUST contain between 1 and 8 bounded text edits."
    },
    {
      id: "bounded-byte-count",
      rule: "The combined UTF-8 byte count of all oldText and newText values MUST NOT exceed 20000 bytes."
    },
    {
      id: "explicit-mutation-authority",
      rule: "Every edit MUST target a required change_allowed mutation path; omitted or non-required source does not grant mutation authority."
    }
  ]
});

function providerTextEditProtocolContract() {
  return {
    schemaVersion: TEXT_EDIT_PROTOCOL.schemaVersion,
    limits: TEXT_EDIT_PROTOCOL.limits,
    resolution: TEXT_EDIT_PROTOCOL.resolution,
    materialization: TEXT_EDIT_PROTOCOL.materialization,
    authority: TEXT_EDIT_PROTOCOL.authority,
    invariants: TEXT_EDIT_PROTOCOL.invariants
  };
}

module.exports = {
  TEXT_EDIT_PROTOCOL,
  providerTextEditProtocolContract
};
