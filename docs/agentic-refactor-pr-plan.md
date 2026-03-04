# Agentic Refactor: Upstream PR Plan

This document outlines the strategy for submitting the "Agentic Refactor"
changes from our private fork to the upstream public repository
(`google-gemini/gemini-cli`).

**CRITICAL MANDATE:** We will execute this process strictly "by the book" as
defined in `CONTRIBUTING.md`. Every step must follow this exact sequence:

1.  **Issue Creation:** Open an issue describing the specific need or
    architectural change. Wait for maintainer approval/alignment (or
    self-approve if appropriate, but the issue must exist).
2.  **Branching:** Create a clean, focused branch for the specific PR.
3.  **Implementation:** Write the code and comprehensive tests.
4.  **Verification:** Run `npm run preflight` and ensure absolute 100% pass
    rate. No exceptions.
5.  **Draft PR (Optional):** If a PR is intentionally incomplete or needs early
    architectural review, it MUST be marked as a DRAFT.
6.  **Final PR:** Submit the PR, linking it to the corresponding issue (e.g.,
    `Fixes #123`).

To ensure PRs are "small and focused", we will break the monolithic refactor
branch into the following sequential pull requests:

---

## PR 1: Design Document for Modular Agent Architecture

**Goal:** Establish consensus on the architectural direction before merging
code.

- **Pre-requisite:** Create an Issue proposing the transition from a monolithic
  execution loop to an interface-driven modular architecture.
- **Contents:**
  - `docs/agentic-refactor.md`
- **Verification:** `npm run preflight` (ensures markdown linting and formatting
  pass).
- **Notes:** This PR should only contain documentation. It serves as the
  reference point for all subsequent PRs.

## PR 2: Define Core Agent and Model Interfaces

**Goal:** Introduce the foundational TypeScript interfaces without altering
existing runtime behavior.

- **Pre-requisite:** Create an Issue (or use the one from PR 1) detailing the
  need for stable `Agent`, `Model`, and `AgentEvent` contracts.
- **Contents:**
  - `packages/core/src/interfaces/agent.ts`
  - `packages/core/src/interfaces/model.ts`
  - `packages/core/src/interfaces/verification.test.ts`
- **Verification:** `npm run preflight` (ensures types compile and interface
  tests pass).
- **Notes:** These files should be pure definitions and types.

## PR 3: Refactor Local Agent Executor to use new Interfaces

**Goal:** Migrate the legacy internal execution loop to implement the new
`Agent` interface natively.

- **Pre-requisite:** Create an Issue for refactoring the `LocalAgentExecutor` to
  act as an `AsyncGenerator` yielding `AgentEvent`s.
- **Contents:**
  - `packages/core/src/agents/local-executor.ts`
  - `packages/core/src/agents/local-executor.test.ts`
  - `packages/core/src/agents/local-invocation.ts`
  - `packages/core/src/agents/local-invocation.test.ts`
- **Verification:** `npm run preflight` (This is the most critical step; it
  ensures the core engine still passes all unit and E2E tests after the
  refactor).
- **Notes:** This PR changes the core engine but should result in zero
  behavioral changes for the end-user. The tests must rigorously prove this.

## PR 4: Update Browser Agent to consume AgentEvent Stream

**Goal:** Ensure all internal sub-agents conform to the new streaming
architecture.

- **Pre-requisite:** Create an Issue for porting the experimental browser agent
  to the new event stream.
- **Contents:**
  - `packages/core/src/agents/browser/browserAgentInvocation.ts`
- **Verification:** `npm run preflight`.
- **Notes:** This finalizes the refactor across the currently active internal
  agents.

---

**Final Check:** No PR will be opened until the code for that specific slice
passes `npm run preflight` in isolation.
