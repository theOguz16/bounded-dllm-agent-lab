"use strict";

const verifier = require("./gate6-verifier-provenance.cjs");

const VALIDATOR_CONTRACT_VERSION = "gate6-live-validator-contract/v1";

const PROVIDER_FACING_RULE_IDS = Object.freeze([
  "output.exact_top_level_schema",
  "selection.exact_schema",
  "selection.public_candidate_universe_only",
  "selection.no_duplicates",
  "selection.safe_relative_paths",
  "selection.disjoint_implementation_and_test",
  "proposal.exact_schema",
  "proposal.action_patch_or_no_change",
  "proposal.summary_nonempty_bounded",
  "proposal.edits_bounded",
  "proposal.action_edits_consistent",
  "proposal.edit_exact_schema",
  "proposal.safe_relative_paths",
  "proposal.expected_content_hash_required",
  "proposal.old_new_text_valid",
  "proposal.public_candidate_universe_only",
  "proposal.authority_allowed_paths_only",
  "proposal.forbidden_paths_rejected",
  "proposal.no_duplicate_edits",
  "proposal.no_overlapping_edits",
  "proposal.expected_content_hash_matches_source",
  "proposal.old_text_unique_in_source"
]);

const SELECTION_NORMATIVE_RULE_IDS = Object.freeze([
  "selection.exact_schema",
  "selection.public_candidate_universe_only",
  "selection.no_duplicates",
  "selection.safe_relative_paths",
  "selection.disjoint_implementation_and_test",
  "selection.max_items_and_valid_strings"
]);

const PROPOSAL_NORMATIVE_RULE_IDS = Object.freeze([
  "proposal.exact_schema",
  "proposal.action_patch_or_no_change",
  "proposal.summary_nonempty_bounded",
  "proposal.edits_bounded",
  "proposal.action_edits_consistent",
  "proposal.edit_exact_schema",
  "proposal.safe_relative_paths",
  "proposal.expected_content_hash_required",
  "proposal.old_new_text_valid"
]);

const PREFLIGHT_NORMATIVE_RULE_IDS = Object.freeze([
  "proposal.public_candidate_universe_only",
  "proposal.authority_allowed_paths_only",
  "proposal.forbidden_paths_rejected",
  "proposal.no_duplicate_edits",
  "proposal.no_overlapping_edits",
  "proposal.expected_content_hash_matches_source",
  "proposal.old_text_unique_in_source"
]);

function validatorContractDescriptor() {
  return Object.freeze({
    validatorContractVersion: VALIDATOR_CONTRACT_VERSION,
    providerFacingRuleIds: Object.freeze([...PROVIDER_FACING_RULE_IDS]),
    selectionNormativeRuleIds: Object.freeze([...SELECTION_NORMATIVE_RULE_IDS]),
    proposalNormativeRuleIds: Object.freeze([...PROPOSAL_NORMATIVE_RULE_IDS]),
    preflightNormativeRuleIds: Object.freeze([...PREFLIGHT_NORMATIVE_RULE_IDS])
  });
}

function validatorContractHash(descriptor = validatorContractDescriptor()) {
  return verifier.hashCanonical(descriptor);
}

const VALIDATOR_CONTRACT_HASH = validatorContractHash();

function sameStringSet(left, right) {
  return Array.isArray(left) && Array.isArray(right) &&
    JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function contractMismatch(detail) {
  const error = new Error(detail ? `GATE6_PROVIDER_VALIDATOR_CONTRACT_MISMATCH: ${detail}` : "GATE6_PROVIDER_VALIDATOR_CONTRACT_MISMATCH");
  error.code = "GATE6_PROVIDER_VALIDATOR_CONTRACT_MISMATCH";
  return error;
}

function assertProviderValidatorContractCompatibility(providerDescriptor, validatorDescriptor = validatorContractDescriptor()) {
  if (!providerDescriptor || typeof providerDescriptor !== "object") throw contractMismatch("provider_descriptor_missing");
  if (!validatorDescriptor || typeof validatorDescriptor !== "object") throw contractMismatch("validator_descriptor_missing");
  if (!sameStringSet(providerDescriptor.ruleManifest, validatorDescriptor.providerFacingRuleIds)) {
    throw contractMismatch("provider_facing_rule_manifest");
  }
  return true;
}

module.exports = {
  PREFLIGHT_NORMATIVE_RULE_IDS,
  PROPOSAL_NORMATIVE_RULE_IDS,
  PROVIDER_FACING_RULE_IDS,
  SELECTION_NORMATIVE_RULE_IDS,
  VALIDATOR_CONTRACT_HASH,
  VALIDATOR_CONTRACT_VERSION,
  assertProviderValidatorContractCompatibility,
  validatorContractDescriptor,
  validatorContractHash
};
