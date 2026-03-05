# Google ADK Integration Guide & Roadmap

This document outlines the integration of the Google Agent Development Kit (ADK)
with gemini-cli. It serves as a guide for understanding the architecture of the
adapters implemented to support ADK as a first-class runtime for Gemini CLI.

This guide assumes the core gemini-cli architecture follows the pattern defined
in `docs/agentic-refactor.md` (Factory Pattern, Interfaces, and Adapters).

## 1. Integration Workflow

To achieve a seamless integration, the development process follows this
dependency chain:

1. **Core Refactor:** gemini-cli establishes framework-agnostic interfaces
   (`Agent`, `Model`, `AgentEvent`) and a factory-based executor. (See
   `docs/agentic-refactor.md`)
1. **ADK Enhancements:** The upstream `@google/adk` framework was enhanced to
   support critical features like native event streaming (`runAsync`), ephemeral
   sessions (`runEphemeral`), structured event parsing (`toStructuredEvents`),
   and explicit execution suspension (`pauseOnToolCalls`).
1. **Adapter Implementation:** gemini-cli implements the adapters
   (`AdkAgentWrapper`, `AdkGeminiModel`, `AdkToolAdapter`) to bridge the gap.
1. **Activation:** The ADK backend is enabled via the `experimental.useAdk`
   feature flag.

## 2. Architecture & Solutions

### 2.1. First-Class Streaming Support

**Context:** The CLI relies on real-time feedback to the user. Users expect to
see the agent thinking, calling tools, and streaming partial content tokens as
they are generated.

**Solution:** We utilize the `runAsync` and `runEphemeral` methods exposed by
the ADK `Runner`.

- **Mechanism:** `AdkAgentWrapper` calls `runner.runAsync()`, which returns an
  `AsyncGenerator` yielding raw ADK `Event` objects.
- **Event Mapping:** The wrapper uses ADK's `toStructuredEvents` utility to
  parse the raw `Event` stream into logical parts, and maps them to the standard
  CLI `AgentEvent` union type (e.g. mapping ADK's `ThoughtEvent` to CLI's
  `{ type: 'thought' }`).

### 2.2. Human-in-the-Loop (HITL) & Tool Approval

**Context:** Safety is paramount in a CLI agent. gemini-cli enforces a
Client-Side Tool Execution model where sensitive tools (e.g., `rm -rf`,
`git push`) require explicit user approval before execution.

**Solution (UI-Driven):**

The ADK runner is configured with `pauseOnToolCalls: true` in its `RunConfig`.
When the ADK model requests a tool call, the runner yields a raw `Event`
containing the `functionCall`, and immediately suspends the loop, preventing
autonomous execution.

The `AdkAgentWrapper` maps this to a `tool_call` `AgentEvent`, allowing the CLI
UI to render its native confirmation widget. Upon approval, the CLI invokes the
tool and passes the response back into the runner to resume execution.

### 2.3. Session Isolation & Model State

**Context:** `LlmAgent` instances are often constructed once (singleton
definition) but executed multiple times (per user command). Reusing stateful
models across runs can cause context leaks.

**Solution:** `AdkAgentWrapper` leverages ADK's execution modes and
`SessionService`.

- **Interactive Loop (`runAsync`):** When `agent.runAsync(input, { sessionId })`
  is called, the wrapper uses the ADK runner to automatically append events to
  the existing persistent session.
- **Sub-agents (`runEphemeral`):** For stateless, single-turn executions, the
  wrapper utilizes ADK's `runEphemeral`, which creates a temporary session,
  executes the task, and automatically cleans up the session data.

## 3. Adapters Implementation

To support ADK, three key adapters are implemented in `packages/core/src/adk/`:

### 3.1. AdkAgentWrapper

- **Implements:** `Agent` interface.
- **Wraps:** `LlmAgent` and `Runner`.
- **Role:** The main entry point. It translates CLI inputs into ADK messages,
  manages the `pauseOnToolCalls` configuration, invokes the correct ADK run
  method, and converts the ADK event stream into `AgentEvent`s using
  `toStructuredEvents`.

### 3.2. AdkGeminiModel

- **Implements:** `BaseLlm` (ADK interface).
- **Wraps:** `GeminiChat` (CLI class).
- **Role:** Allows ADK agents to use the CLI's pre-configured, authenticated
  Gemini client. It handles:
  - **Streaming:** Calls `GeminiChat.sendMessageStream`.
  - **Error Handling:** Propagates standard `Error` objects so the ADK runner
    can handle them gracefully.
  - **Content Mapping:** Converts between ADK `LlmRequest` and Gemini `Part`
    structures.

### 3.3. AdkToolAdapter

- **Implements:** `BaseTool` (ADK interface).
- **Wraps:** `DeclarativeTool` (CLI class).
- **Role:** Exposes CLI tools to the ADK agent. It converts ADK tool calls into
  CLI tool executions, ensuring that telemetry and permission checks
  (implemented in the CLI tool) are preserved.

## 4. Configuration

To enable the ADK backend for both sub-agents and the main interactive loop:

```bash
npm start -- config set experimental.useAdk true
```

This flag instructs the `AgentFactory` (used by `LocalAgentExecutor` and
`GeminiClient`) to instantiate the ADK-based adapters instead of the legacy
loop.

## 5. Developer Experience (DX)

### 5.1. Dynamic System Instructions

**Context:** CLI agents often require context-aware system prompts (e.g., "You
are running in `/home/user/project`").

**Solution:** `AdkAgentFactory` provides a dynamic `InstructionProvider` to the
ADK `LlmAgent` constructor. The provider leverages the ADK `ReadonlyContext`
(which includes the `userId` and `sessionId`) alongside the CLI's environment
details to construct the final system prompt at runtime.

### 5.2. Type Exports

**Context:** Building adapters requires implementing core ADK interfaces.

**Solution:** The `@google/adk` package exports all necessary types and
utilities (`Event`, `EventType`, `StructuredEvent`, `toStructuredEvents`, etc.)
directly from its root index, simplifying imports in the CLI codebase.
