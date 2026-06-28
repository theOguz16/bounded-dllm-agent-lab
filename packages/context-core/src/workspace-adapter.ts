import type { BoundedContextPacket } from "./index.js";
import {
  createWorkspace,
  type CreateWorkspaceInput,
  type SharedSemanticWorkspace,
  type WorkspaceAuthority,
  type WorkspacePatchIntent,
  type WorkspacePolicy,
  type WorkspaceRepoFacts,
  type WorkspaceScope,
  type WorkspaceTask
} from "../../workspace-core/src/index.js";

export type WorkspaceFromPacketOptions = {
  id: string;
  createdAt?: string;
};

type PacketFact = BoundedContextPacket["facts"][number];

export type WorkspaceEvidenceFact = {
  id: string;
  kind: PacketFact["kind"];
  content: string;
  evidenceId: string;
  confidence: number;
};

export type WorkspaceAuthorityWithEvidence = WorkspaceAuthority & {
  /**
   * Runtime canonical workspace packet bilmez.
   * Ama benchmark/eval için packet fact evidence id'lerini kaybetmememiz gerekir.
   *
   * Bu alan optional schema migration yolu gibi kullanılır:
   * - workspace-core packet import etmez
   * - adapter evidence metadata'yı taşır
   * - benchmark selector'ları gerekirse buradan evidenceId okur
   */
  evidenceFacts: WorkspaceEvidenceFact[];
};

export type WorkspaceRepoFactsWithEvidence = WorkspaceRepoFacts & {
  /**
   * Stale/sensitive/current/correction tüm packet fact metadata'sı.
   * Eval coverage için evidence id burada korunur.
   */
  evidenceFacts: WorkspaceEvidenceFact[];
};

/**
 * BoundedContextPacket eski research/benchmark dünyasının input formatıdır.
 * SharedSemanticWorkspace ise yeni product/runtime state modelidir.
 *
 * Bu dosya ikisini bilinçli olarak ayırır:
 * - workspace-core packet bilmez
 * - research fixture'ları yine workspace üretebilir
 * - migration tek noktadan yönetilir
 * - evidence id'ler adapter aşamasında kaybolmaz
 */
export function createWorkspaceFromPacket(
  packet: BoundedContextPacket,
  options: WorkspaceFromPacketOptions
): SharedSemanticWorkspace {
  return createWorkspace(createWorkspaceInputFromPacket(packet, options));
}

export function createWorkspaceInputFromPacket(
  packet: BoundedContextPacket,
  options: WorkspaceFromPacketOptions
): CreateWorkspaceInput {
  const allowedPaths = packet.allowedScope.map(scopeRegionToPath);
  const forbiddenPaths = packet.forbiddenScope.map(scopeRegionToPath);
  const evidenceFacts = createEvidenceFactsFromPacket(packet);

  const authorityEvidenceFacts = evidenceFacts.filter(
    (fact) => fact.kind === "current" || fact.kind === "correction"
  );

  return {
    id: options.id,
    createdAt: options.createdAt,
    task: createTaskFromPacket(packet, authorityEvidenceFacts),
    scope: createScopeFromPacket(allowedPaths, forbiddenPaths),
    authority: createAuthorityFromPacket(packet, authorityEvidenceFacts),
    policy: createPolicyFromPacket(packet, allowedPaths, forbiddenPaths),
    repoFacts: createRepoFactsFromPacket(evidenceFacts),
    patchIntent: createPatchIntentFromPacket()
  };
}

function createTaskFromPacket(
  packet: BoundedContextPacket,
  authorityEvidenceFacts: WorkspaceEvidenceFact[]
): WorkspaceTask {
  return {
    id: packet.id,
    title: packet.task,
    description: packet.goal,

    /**
     * Packet facts içinden sadece current/correction olanları authority tarafına
     * taşıyoruz. Stale/sensitive/uncertain facts doğrudan authority sayılmaz.
     */
    authorityFacts: authorityEvidenceFacts.map((fact) => fact.content)
  };
}

function createScopeFromPacket(
  allowedPaths: string[],
  forbiddenPaths: string[]
): WorkspaceScope {
  return {
    allowed: allowedPaths,
    forbidden: forbiddenPaths,

    /**
     * Packet fixture diff taşımaz.
     * Patch dosyaları product-runtime veya benchmark adapter katmanında gelir.
     */
    changedFiles: []
  };
}

function createAuthorityFromPacket(
  packet: BoundedContextPacket,
  authorityEvidenceFacts: WorkspaceEvidenceFact[]
): WorkspaceAuthority {
  const authority: WorkspaceAuthorityWithEvidence = {
    facts: authorityEvidenceFacts.map((fact) => fact.content),

    /**
     * mustNotInfer eski boundaryDecision alanının yerine geçmez.
     * Yeni mimaride bu bilgi verifier/merge kararında kullanılır.
     */
    missingRules: packet.mustNotInfer,

    /**
     * Eval/benchmark tarafı için evidence id'leri burada kaybetmiyoruz.
     * Workspace-core hâlâ packet bilmez.
     */
    evidenceFacts: authorityEvidenceFacts
  };

  return authority;
}

function createPolicyFromPacket(
  packet: BoundedContextPacket,
  allowedPaths: string[],
  forbiddenPaths: string[]
): WorkspacePolicy {
  return {
    allowedPaths,
    forbiddenPaths,
    ownership: {},
    ownerAliases: {},
    pairedFiles: [],
    sensitivePatterns: packet.facts
      .filter((fact) => fact.kind === "sensitive")
      .map((fact) => fact.content),
    requiredTests: [],
    requiredTestMappings: [],
    moduleBoundaries: [],
    missingAuthorityRules: packet.mustNotInfer
  };
}

function createRepoFactsFromPacket(
  evidenceFacts: WorkspaceEvidenceFact[]
): WorkspaceRepoFacts {
  const repoFacts: WorkspaceRepoFactsWithEvidence = {
    changedFiles: [],
    ownership: {},
    pairedFiles: [],
    requiredTests: [],
    requiredTestMappings: [],
    moduleBoundaries: [],
    sensitivePatterns: evidenceFacts
      .filter((fact) => fact.kind === "sensitive")
      .map((fact) => fact.content),
    staleFacts: evidenceFacts
      .filter((fact) => fact.kind === "stale")
      .map((fact) => fact.content),

    /**
     * Stale/sensitive/current/correction ayrımıyla tüm evidence metadata korunur.
     * Böylece selector'lar generic id üretmek yerine fixture'daki gerçek evidenceId'yi okuyabilir.
     */
    evidenceFacts
  };

  return repoFacts;
}

function createPatchIntentFromPacket(): WorkspacePatchIntent {
  return {
    rawDiff: "",
    changedFiles: []
  };
}

function createEvidenceFactsFromPacket(packet: BoundedContextPacket): WorkspaceEvidenceFact[] {
  return packet.facts.map((fact, index) => ({
    id: getFactId(fact, index),
    kind: fact.kind,
    content: fact.content,
    evidenceId: getFactEvidenceId(fact, index),
    confidence: getFactConfidence(fact)
  }));
}

function getFactId(fact: PacketFact, index: number): string {
  const record = fact as PacketFact & {
    id?: unknown;
  };

  if (typeof record.id === "string" && record.id.length > 0) {
    return record.id;
  }

  return `packet-fact-${index}`;
}

function getFactEvidenceId(fact: PacketFact, index: number): string {
  const record = fact as PacketFact & {
    evidenceId?: unknown;
    id?: unknown;
  };

  if (typeof record.evidenceId === "string" && record.evidenceId.length > 0) {
    return record.evidenceId;
  }

  if (typeof record.id === "string" && record.id.length > 0) {
    return record.id;
  }

  return `packet-fact-${index}`;
}

function getFactConfidence(fact: PacketFact): number {
  const record = fact as PacketFact & {
    confidence?: unknown;
  };

  if (typeof record.confidence === "number") {
    return record.confidence;
  }

  if (fact.kind === "current" || fact.kind === "correction") {
    return 0.9;
  }

  if (fact.kind === "sensitive") {
    return 0.75;
  }

  if (fact.kind === "stale") {
    return 0.45;
  }

  return 0.5;
}

function scopeRegionToPath(region: BoundedContextPacket["allowedScope"][number]): string {
  return region.path ?? region.label;
}