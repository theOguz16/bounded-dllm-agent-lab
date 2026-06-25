# Glossary

## Autoregressive LLM

A language model that usually generates text from left to right. Each next token depends on the tokens generated before it.

## dLLM

A diffusion-style language model. In this project, the term means a model used for masked or iterative refinement of language/code-like structures.

## Bounded Context

A small but high-value context package that includes only the task-relevant facts, constraints, allowed scope, forbidden scope, and verification rules.

## Synthetic Context Enrichment

The process of turning raw data into a more useful context packet. Instead of sending all raw memory or all raw code, the system sends a compressed and structured representation.

## Shared Semantic Workspace

A structured state object shared by all agent roles. It contains task context, claims, masks, conflicts, risks, verifier feedback, and final decisions.

## Bounded Working Memory

A task-bound, ephemeral, policy-bound role view generated from the shared workspace. It gives an agent the minimum context needed for its role instead of the whole repo or all chat history.

## Context Composer

The runtime layer that selects which workspace fields a role receives, which facts are excluded, and how much token budget the role view uses.

## Remask Request

A verifier-triggered request to reopen only a local failed workspace or patch region. Remask is not a default second pass for every patch.

## Merge Decision

The runtime's final decision after verifier, remask, policy and conflict signals are written to the workspace.

## Masking Policy

Rules that decide which parts of the workspace should be generated or regenerated.

## Mask View

A role-specific view of the shared workspace. A mask view defines which regions a role can read, which regions it can refine, and which regions must stay locked.

## Locked Region

A workspace region that a role must not edit. Locked regions protect the experiment from scope drift and accidental overwrite between agents.

## BoundaryMask

A mask view that asks whether the system has enough context to proceed safely.

## Scope Drift

When an agent does more than requested, touches forbidden areas, or invents extra features.

## Verifier

A deterministic checker that scores whether an output followed the task, respected boundaries, and avoided leakage.
