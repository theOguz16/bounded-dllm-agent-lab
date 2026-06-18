export type ContextFactKind = "current" | "stale" | "correction" | "sensitive" | "uncertain";

// Scope region, çalışmanın sınırlandırılmış bir alanıdır. Bu alan bir dosya,
// modül, API yüzeyi, doküman bölümü veya kavramsal sınır olabilir. Benchmark
// case'leri agent'ın izin verilen çalışma alanında kalıp kalmadığını bununla ölçer.
export type ContextScopeRegion = {
  id: string;
  label: string;
  path?: string;
  reason: string;
};

// Fact, modelin ihtiyaç duyabileceği tekil bir bağlam bilgisidir. Buradaki kind
// alanı önemlidir: current ve correction genelde kazanmalı, stale genelde
// kaybetmeli, sensitive genelde gizli kalmalı, uncertain ise agent'ı eminmiş gibi
// tahmin yürütmek yerine boundary decision üretmeye itmelidir.
export type ContextFact = {
  id: string;
  kind: ContextFactKind;
  content: string;
  evidenceId: string;
  confidence: number;
};

// Bu packet, araştırma projesinin merkezi input nesnesidir. Karşılaştırdığımız
// her mimari, model çağrısına farklı formatta hazırlasa bile aynı semantik
// bilgiyi bu nesne üzerinden almalıdır.
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

// Bu token tahmini bilinçli olarak basit tutuldu. Issue #1 için tokenizer'a tam
// uyan bir sayıdan çok, deterministik bir bütçe sinyali gerekiyor. İleride gerekirse
// bunu model bazlı tokenizer'larla değiştirebiliriz.
export function estimateContextTokens(packet: BoundedContextPacket): number {
  const text = JSON.stringify(packet);
  return Math.ceil(text.length / 4);
}

// Bu yardımcı fonksiyonlar benchmark kodunu okunur tutar. Aynı zamanda şu zihinsel
// modeli öğretir: fact'ler sadece metin parçaları değildir; policy rolleri vardır.
export function sensitiveFacts(packet: BoundedContextPacket): ContextFact[] {
  return packet.facts.filter((fact) => fact.kind === "sensitive");
}

export function staleFacts(packet: BoundedContextPacket): ContextFact[] {
  return packet.facts.filter((fact) => fact.kind === "stale");
}

export function currentFacts(packet: BoundedContextPacket): ContextFact[] {
  return packet.facts.filter((fact) => fact.kind === "current" || fact.kind === "correction");
}
