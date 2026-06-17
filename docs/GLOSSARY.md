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

## Masking Policy

Rules that decide which parts of the workspace should be generated or regenerated.

## BoundaryMask

A mask view that asks whether the system has enough context to proceed safely.

## Scope Drift

When an agent does more than requested, touches forbidden areas, or invents extra features.

## Verifier

A deterministic checker that scores whether an output followed the task, respected boundaries, and avoided leakage.

