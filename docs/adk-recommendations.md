# ADK TypeScript Recommendations

Based on the integration of `gemini-cli` with ADK (`@google/adk`), here are the
identified gaps and recommendations that should be filed as issues in the
`google/adk-js` repository:

## 1. Context Pass-through (Prompt IDs & Signals)

**Issue:** The `BaseLlm` and `BaseTool` interfaces do not currently provide a
clean way to pass request-scoped metadata (like `promptId`) or an `AbortSignal`
all the way through the execution pipeline. In `gemini-cli`, we rely heavily on
these for telemetry and cancellation.

**Recommendation:** `generateContentAsync` and streaming equivalents should
accept an optional `ExecutionOptions` bag that carries context, signals, and
trace IDs down to the model adapter.

## 2. Multi-Modal Content Type Support

**Issue:** Currently, mapping ADK's `Content` array to Gemini API's `Part`
structures requires workarounds to handle non-text elements (images/tools).
ADK's message structure is slightly different from the official Gemini API
structure.

**Recommendation:** ADK should standardize a richer message format or explicitly
define how multi-modal parts (like inline data and function calls) are
consistently represented to model adapters to avoid brittle mapping code.

## 3. Native Stream Event Compatibility

**Issue:** Consuming streams from `InMemoryRunner` requires manual filtering of
parts for text, thoughts, and function calls. This boilerplate is repeated in
every wrapper.

**Recommendation:** The runner should expose a more structured event stream
(e.g., `onThought`, `onContent`, `onToolCall`) or provide a utility to transform
its raw output into these high-level events.

## 4. Error Standardization

**Issue:** Mismatches between internal error structures can lead to swallowed or
uninformative error messages when crossing the ADK/Application boundary.

**Recommendation:** Ensure that all ADK components consistently propagate native
`Error` objects and provide clear error types that can be caught and handled by
the host application.

## 5. Pluggable Runner Architecture

**Issue:** Currently, `LlmAgent` feels somewhat coupled to the `Runner`
implementation details.

**Recommendation:** Abstract the execution logic further so that custom runners
or execution strategies (like `gemini-cli`'s internal `LegacyLoop`) can more
easily utilize ADK's Agent and Model definitions without necessarily adopting
the full ADK runtime.
