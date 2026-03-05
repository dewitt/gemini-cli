/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion */

import type {
  Agent,
  AgentEvent,
  AgentRunOptions,
} from '../interfaces/agent.js';
import {
  AgentTerminateMode,
  type AgentInputs,
  type OutputObject,
} from '../agents/types.js';
import { InMemoryRunner, type LlmAgent, SecurityPlugin } from '@google/adk';
import { debugLogger } from '../utils/debugLogger.js';

/**
 * Wraps an ADK LlmAgent to implement the Gemini CLI Agent interface.
 * allowing it to be run by the LocalAgentExecutor's consumers.
 */
export class AdkAgentWrapper implements Agent<AgentInputs, OutputObject> {
  private readonly runner: InMemoryRunner;

  constructor(private readonly adkAgent: LlmAgent) {
    this.runner = new InMemoryRunner({
      agent: this.adkAgent,
      appName: 'gemini-cli-adk-wrapper',
      plugins: [new SecurityPlugin()],
    });
  }

  get name() {
    return this.adkAgent.name;
  }

  get description() {
    return this.adkAgent.description || '';
  }

  async *runAsync(
    inputs: AgentInputs,
    options?: AgentRunOptions,
  ): AsyncGenerator<AgentEvent, OutputObject> {
    const sessionId = options?.sessionId || 'default-session';
    const promptId = options?.prompt_id || 'adk-prompt-unknown';

    debugLogger.log(
      `[AdkAgentWrapper] Running ADK agent: ${this.adkAgent.name} (Session: ${sessionId})`,
    );

    yield {
      type: 'activity',
      kind: 'ADK_RUN_START',
      detail: { agentName: this.adkAgent.name, sessionId },
    };

    // Convert inputs to a string message.
    const inputString =
      typeof inputs === 'string' ? inputs : JSON.stringify(inputs, null, 2);

    // Create user content
    const newMessage = {
      role: 'user',
      parts: [{ text: inputString }],
    };

    try {
      // Ensure session exists (using new ergonomics helper)
      await this.runner.sessionService.getOrCreateSession({
        appName: this.runner.appName,
        userId: 'user',
        sessionId,
      });

      const eventStream = this.runner.runAsync({
        userId: 'user',
        sessionId,
        newMessage: newMessage as any,
        runConfig: {
          pauseOnToolCalls: false, // Default to false, can be made configurable
        },
      });

      let finalResult = 'No result returned';

      for await (const event of eventStream) {
        if (event.errorMessage) {
          yield { type: 'error', error: new Error(event.errorMessage) };
        }

        if (event.content && event.content.parts) {
          const textParts = event.content.parts.filter(
            (p) => p.text && !p.thought,
          );
          const thoughtParts = event.content.parts.filter((p) => p.thought);
          const callParts = event.content.parts.filter((p) => p.functionCall);
          const resParts = event.content.parts.filter(
            (p) => p.functionResponse,
          );

          if (thoughtParts.length > 0) {
            yield {
              type: 'thought',
              content: thoughtParts.map((p) => p.text || '').join(''),
            };
          }
          if (textParts.length > 0) {
            const textContent = textParts.map((p) => p.text || '').join('');
            yield { type: 'content', content: textContent };
            finalResult = textContent;
          }

          if (callParts.length > 0) {
            for (const part of callParts) {
              const call = part.functionCall!;
              yield {
                type: 'tool_call',
                call: {
                  callId: call.id || 'adk-id',
                  name: call.name || 'unknown_tool',
                  args: (call.args as Record<string, unknown>) || {},
                  isClientInitiated: false,
                  prompt_id: promptId,
                },
              };
            }
          }

          if (resParts.length > 0) {
            for (const part of resParts) {
              const res = part.functionResponse!;
              yield {
                type: 'tool_result',
                result: {
                  callId: res.id || 'adk-id',
                  responseParts: [part],
                  resultDisplay: 'Executed',
                  error: undefined,
                  errorType: undefined,
                },
              };
            }
          }
        }
      }

      const output: OutputObject = {
        result: finalResult,
        terminate_reason: AgentTerminateMode.GOAL,
      };
      yield { type: 'finished', output };
      return output;
    } catch (error) {
      const err =
        error instanceof Error ? error : new Error(JSON.stringify(error));
      yield { type: 'error', error: err };
      throw err;
    }
  }

  async *runEphemeral(
    inputs: AgentInputs,
    options?: AgentRunOptions,
  ): AsyncGenerator<AgentEvent, OutputObject> {
    const promptId = options?.prompt_id || 'adk-prompt-unknown';

    debugLogger.log(
      `[AdkAgentWrapper] Running ADK agent (Ephemeral): ${this.adkAgent.name}`,
    );

    yield {
      type: 'activity',
      kind: 'ADK_RUN_START',
      detail: { agentName: this.adkAgent.name, sessionId: 'ephemeral' },
    };

    // Convert inputs to a string message.
    const inputString =
      typeof inputs === 'string' ? inputs : JSON.stringify(inputs, null, 2);

    // Create user content
    const newMessage = {
      role: 'user',
      parts: [{ text: inputString }],
    };

    try {
      const eventStream = this.runner.runEphemeral({
        userId: 'user',
        newMessage: newMessage as any,
        runConfig: {
          pauseOnToolCalls: false, // Default to false, can be made configurable
        },
      });

      let finalResult = 'No result returned';

      for await (const event of eventStream) {
        if (event.errorMessage) {
          yield { type: 'error', error: new Error(event.errorMessage) };
        }

        if (event.content && event.content.parts) {
          const textParts = event.content.parts.filter(
            (p) => p.text && !p.thought,
          );
          const thoughtParts = event.content.parts.filter((p) => p.thought);
          const callParts = event.content.parts.filter((p) => p.functionCall);
          const resParts = event.content.parts.filter(
            (p) => p.functionResponse,
          );

          if (thoughtParts.length > 0) {
            yield {
              type: 'thought',
              content: thoughtParts.map((p) => p.text || '').join(''),
            };
          }
          if (textParts.length > 0) {
            const textContent = textParts.map((p) => p.text || '').join('');
            yield { type: 'content', content: textContent };
            finalResult = textContent;
          }

          if (callParts.length > 0) {
            for (const part of callParts) {
              const call = part.functionCall!;
              yield {
                type: 'tool_call',
                call: {
                  callId: call.id || 'adk-id',
                  name: call.name || 'unknown_tool',
                  args: (call.args as Record<string, unknown>) || {},
                  isClientInitiated: false,
                  prompt_id: promptId,
                },
              };
            }
          }

          if (resParts.length > 0) {
            for (const part of resParts) {
              const res = part.functionResponse!;
              yield {
                type: 'tool_result',
                result: {
                  callId: res.id || 'adk-id',
                  responseParts: [part],
                  resultDisplay: 'Executed',
                  error: undefined,
                  errorType: undefined,
                },
              };
            }
          }
        }
      }

      const output: OutputObject = {
        result: finalResult,
        terminate_reason: AgentTerminateMode.GOAL,
      };
      yield { type: 'finished', output };
      return output;
    } catch (error) {
      const err =
        error instanceof Error ? error : new Error(JSON.stringify(error));
      yield { type: 'error', error: err };
      throw err;
    }
  }
}
