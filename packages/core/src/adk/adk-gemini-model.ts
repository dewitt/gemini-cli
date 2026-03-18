/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseLlm } from '@google/adk';
import type { LlmRequest, LlmResponse, BaseLlmConnection } from '@google/adk';
import type { GeminiClient } from '../core/client.js';
import type { Part } from '@google/genai';
import { GeminiEventType } from '../core/turn.js';

export class AdkGeminiModel extends BaseLlm {
  private _client: GeminiClient;
  private _promptId: string;

  constructor(client: GeminiClient, promptId: string, model: string) {
    super({ model });
    this._client = client;
    this._promptId = promptId;
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream?: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    // Basic mapping of ADK LlmRequest to Gemini Part array
    // Since GeminiClient maintains its own conversation history (GeminiChat),
    // and Adk LlmRequest contains the *entire* history, we have a mismatch.
    // However, AdkAgentSession can bypass the normal GeminiChat and just send parts directly
    // to a stateless generation endpoint. But GeminiClient doesn't expose one natively yet
    // without chat history. We will just pass the new parts.
    // For now, we will just extract the last user message to send as parts.
    const lastContent = llmRequest.contents[llmRequest.contents.length - 1];
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const parts = (lastContent?.parts ?? []) as unknown as Part[];

    const abortController = new AbortController();
    const responseStream = this._client.sendMessageStream(
      parts,
      abortController.signal,
      this._promptId,
    );

    const finalParts: Part[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolCalls: any[] = [];

    for await (const event of responseStream) {
      if (event.type === GeminiEventType.Content) {
        finalParts.push({ text: event.value });
        yield {
          content: { role: 'model', parts: [{ text: event.value }] },
        };
      } else if (event.type === GeminiEventType.ToolCallRequest) {
        toolCalls.push(event.value);
      } else if (event.type === GeminiEventType.Error) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const errMessage =
          (event.value as { error?: { message?: string } }).error?.message ??
          'Unknown error';
        throw new Error(errMessage);
      }
      // Other events like ModelInfo, Usage, etc can be ignored for simple mapping.
    }

    if (toolCalls.length > 0) {
      yield {
        content: {
          role: 'model',
          parts: toolCalls.map((tc) => ({
            functionCall: {
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
              name: tc.name,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
              args: tc.args,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
              id: tc.callId,
            },
          })),
        },
      };
    }
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Method not implemented.');
  }
}
