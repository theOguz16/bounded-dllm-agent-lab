export type ContextFactKind = "current" | "stale" | "correction" | "sensitive" | "uncertain";

// A scope region is a named area of work. It can be a file, module, API surface,
// document section, or conceptual boundary. Benchmark cases use this to test
// whether an agent stays inside its allowed working area.
export type ContextScopeRegion = {
  id: string;
  label: string;
  path?: string;
  reason: string;
};

// A fact is one atomic piece of context that a model may need. The kind matters:
// current and correction facts should usually win, stale facts should usually
// lose, sensitive facts should usually remain hidden, and uncertain facts should
// push the agent toward a boundary decision instead of confident guessing.
export type ContextFact = {
  id: string;
  kind: ContextFactKind;
  content: string;
  evidenceId: string;
  confidence: number;
};

// This packet is the central input object for the whole research project.
// Every architecture we compare should receive the same semantic information,
// even if each architecture formats it differently for its own model call.
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

// This token estimate is intentionally simple. For issue #1 we only need a
// deterministic budget signal, not a tokenizer-perfect number. Later issues can
// replace this with model-specific tokenizers if that becomes important.
export function estimateContextTokens(packet: BoundedContextPacket): number {
  const text = JSON.stringify(packet);
  return Math.ceil(text.length / 4);
}

// These helper functions keep benchmark code readable. They also teach the
// intended mental model: facts are not just text chunks; they have policy roles.
export function sensitiveFacts(packet: BoundedContextPacket): ContextFact[] {
  return packet.facts.filter((fact) => fact.kind === "sensitive");
}

export function staleFacts(packet: BoundedContextPacket): ContextFact[] {
  return packet.facts.filter((fact) => fact.kind === "stale");
}

export function currentFacts(packet: BoundedContextPacket): ContextFact[] {
  return packet.facts.filter((fact) => fact.kind === "current" || fact.kind === "correction");
}
