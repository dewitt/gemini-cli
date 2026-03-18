# Google ADK integration guide and roadmap

This document outlines the integration of the Google Agent Development Kit (ADK)
with Gemini CLI. It serves as a guide for understanding the architectural gaps
addressed and the `AdkAgentSession` implemented to support ADK as a first-class
runtime for Gemini CLI.

This guide assumes the core Gemini CLI architecture follows the pattern defined
by the `AgentSession` interface, standardizing input and output across different
agent backends.

## Integration workflow

To achieve a seamless integration, the development process follows this
dependency chain.

1. **Core refactor:** Gemini CLI establishes a framework-agnostic `AgentSession`
   interface, standardizing input (`send`) and output (`stream`) via the
   `AgentEvent` protocol.
1. **ADK enhancements:** The ADK framework supports critical features like
   streaming (`runAsync`) and robust error handling.
1. **Session implementation:** Gemini CLI implements `AdkAgentSession` to bridge
   the gap, acting as a lightweight wrapper around the ADK `InMemoryRunner`.
1. **Activation:** The ADK backend is enabled via the `experimental.useAdk`
   feature flag.

## Architecture and solutions

This section details the specific architectural solutions implemented to adapt
the ADK runner to the interactive CLI environment.

### First-class streaming support

Gemini CLI relies on real-time feedback. Users expect to see the agent thinking,
calling tools, and streaming partial content tokens.

We utilize the `runAsync(input)` method exposed by the `InMemoryRunner` in the
ADK.

- **Mechanism:** `AdkAgentSession` calls `runner.runAsync()`, which returns an
  `AsyncGenerator`.
- **Event mapping:** The session translates ADK internal events (content,
  thought, tool call) directly into standard CLI `AgentEvent` types (for
  example, `stream_start`, `message`, `tool_request`, and `stream_end`).

### Human-in-the-loop and tool approval

Safety is paramount in a CLI agent. Gemini CLI enforces a client-side tool
execution model where sensitive tools require explicit user approval.

- **Current state (Headless):** The ADK runner executes tools internally.
  Security checks must be handled inside the ADK tool adapter itself or via an
  ADK `SecurityPlugin`.
- **Future state (UI-Driven):** The ADK runner will be configured to yield
  `tool_call` events and pause execution. The `AdkAgentSession` will emit a
  `tool_request` event, allowing the CLI UI to render its native confirmation
  widget. Upon approval, the CLI will resume the session via `send()`.

### Session isolation and model state

Reusing stateful models across runs can cause context leaks.

`AdkAgentSession` relies on the `AgentSession` abstraction, which maps strictly
to an active conversation thread.

- **Session lifecycle:** A new `AdkAgentSession` is instantiated per
  conversation. It maintains the message history and delegates tool execution to
  the underlying ADK runner while keeping different CLI sessions cleanly
  isolated.

## Implementation

To support ADK, the core implementation resides in `packages/core/src/adk/`.

### AdkAgentSession

The `AdkAgentSession` is the primary bridge between the ADK and Gemini CLI.

- **Implements:** `AgentSession` interface.
- **Wraps:** ADK `InMemoryRunner` or `LlmAgent`.
- **Role:** The main entry point. It translates CLI `AgentSend` payloads into
  ADK messages, manages the session lifecycle, and converts the ADK event stream
  into a pure `AgentEvent` asynchronous iterator for the CLI UI.

### Adapters

To ensure seamless dependency injection and compatibility with the CLI's existing functionality, we have implemented specialized adapters:

- **Model adapter (`AdkGeminiModel`):** Allows ADK agents to use the CLI's pre-configured, authenticated Gemini client (`GeminiClient`). This ensures the ADK agent respects the user's local auth state and model selections.
- **Tool adapter (`AdkToolAdapter`):** Exposes CLI tools (`AnyDeclarativeTool`) to the ADK agent, wrapping them so they can be executed by the CLI's central `Scheduler`. This preserves built-in telemetry, context limits, and safety permission checks.

## Configuration

To enable the ADK backend for the main interactive loop, set the `GEMINI_CLI_USE_ADK` environment variable.

```bash
GEMINI_CLI_USE_ADK=true npm run start
```

This flag instructs the core CLI loop to instantiate the `AdkAgentSession`
instead of the legacy `LegacyAgentSession`.

## Recommendations for ADK TS improvements

Based on the integration experience, we recommend the following enhancements for
the ADK TypeScript implementation to better support real-world, interactive CLI
applications.

### Robust error handling contract

The `LlmAgent` assumes all model errors are JSON-stringified objects. If a model
adapter throws a native `Error` or a plain string, the runner crashes while
attempting to parse the message.

We recommend supporting standard `Error` objects and plain strings in the agent
execution loop, using a standardized wrapper for non-JSON errors.

### Type compatibility and structural interfaces

Direct dependencies on specific versions of `@google/genai` in ADK cause type
mismatches when the host application uses a different version.

We recommend utilizing structural typing for core data shapes (like `Part` and
`Content`) or re-exporting these types from the ADK root to avoid double-import
conflicts in monorepo environments.

### Flexible agent naming

The `LlmAgent` enforces strict alphanumeric naming patterns. Standard CLI naming
conventions (using hyphens) currently cause immediate initialization failures.

We recommend relaxing validation to allow common identifier characters like
hyphens.

### Fine-grained execution control

The `runAsync` implementation currently auto-executes tools. For full
human-in-the-loop support, the host needs the ability to pause execution at the
tool call stage.

We recommend implementing a step-based execution mode or a configuration flag
that yields a `tool_call` event and suspends the generator, waiting for an
explicit `resume()` call with the tool output.
