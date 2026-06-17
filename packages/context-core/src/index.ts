export type ContextFactKind = "current" | "stale" | "correction" | "sensitive" | "uncertain";

export type ContextScopeRegion = {
  id: string;
  label: string;
  path?: string;
  reason: string;
};

export type ContextFact = {
  id: string;
  kind: ContextFactKind;
  content: string;
  evidenceId: string;
  confidence: number;
};

export type BoundedContextPacket = {
  id: string;
  task: string;
  goal: string;
  allowedScope: ContextScopeRegion[];
  forbiddenScope: ContextScopeRegion[];
  facts: ContextFact[];
  mustNotInfer: string[];
  expectedOutput: string;
  contextBudgetTokens: number;
};

export function estimateContextTokens(packet: BoundedContextPacket): number {
  const text = JSON.stringify(packet);
  return Math.ceil(text.length / 4);
}

export function sensitiveFacts(packet: BoundedContextPacket): ContextFact[] {
  return packet.facts.filter((fact) => fact.kind === "sensitive");
}

export function staleFacts(packet: BoundedContextPacket): ContextFact[] {
  return packet.facts.filter((fact) => fact.kind === "stale");
}

export function currentFacts(packet: BoundedContextPacket): ContextFact[] {
  return packet.facts.filter((fact) => fact.kind === "current" || fact.kind === "correction");
}

