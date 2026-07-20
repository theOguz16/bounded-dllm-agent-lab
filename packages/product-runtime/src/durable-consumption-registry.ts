import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hashCanonicalJson } from "./agent-event-ledger.js";
import type { ControlledApplyHandoffPlan } from "./controlled-apply-handoff.js";

export const DURABLE_CONSUMPTION_REGISTRY_VERSION = "1" as const;
export type DurableConsumptionStatus = "reserved