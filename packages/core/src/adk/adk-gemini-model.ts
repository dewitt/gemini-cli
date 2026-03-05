/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-unsafe-assignment */

import {
  BaseLlm,
  type LlmRequest,
  type LlmResponse,
  type BaseLlmConnection,
} from '@google/adk';
import type { GeminiChat } from '../core/geminiChat.js';
import { StreamEventType } from '../core/geminiChat.js';
import { LlmRole } from '../telemetry/llmRole.js';

/**
 * Structural types for @google/genai to avoid version mismatches.
 */
interface StructuralPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
  fileData?: {
    mimeType: string;
    fileUri: string;
  };
  functionCall?: {
    name: string;
    args: Record<string, unknown>;
    id?: string;
  };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
    id?: string;
  };
  thought?: boolean;
}

interface StructuralContent {
  role: string;
  parts: StructuralPart[];
}

/**
 * Adapts the Gemini CLI's GeminiChat to the ADK Model interface.
 * This allows ADK agents to use the CLI's configured model, telemetry, and retry logic.
 */
export class AdkGeminiModel extends BaseLlm {
  constructor(
    private readonly chat: GeminiChat,
    private readonly modelName: string,
  ) {
    super({ model: modelName });
  }

  async connect(): Promise<BaseLlmConnection> {
    // Return a dummy connection object
    return {} as BaseLlmConnection;
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, unknown> {
    // Extract the last message from the ADK request
    const messages = request.contents || (request as any).messages;
    const lastMessage = messages?.[messages.length - 1];

    if (!lastMessage || lastMessage.role !== 'user') {
      throw new Error(
        'AdkGeminiModel expects the last message in prompt to be from user.',
      );
    }

    const inputParts: any[] = [];

    // Handle standard @google/genai Content object (has 'parts')
    if (lastMessage.parts && Array.isArray(lastMessage.parts)) {
      inputParts.push(...(lastMessage.parts as any[]));
    }
    // Legacy/Alternative structure support (has 'content')
    else if (typeof (lastMessage as any).content === 'string') {
      inputParts.push({ text: (lastMessage as any).content });
    } else if (
      (lastMessage as any).content &&
      Array.isArray((lastMessage as any).content)
    ) {
      // Handle array content (multi-modal) if ADK supports it matching Gemini parts
      for (const part of (lastMessage as any).content) {
        if (typeof part === 'object' && part !== null && 'text' in part) {
          inputParts.push({ text: String(part.text) });
        }
      }
    }

    if (inputParts.length === 0) {
      throw new Error(
        'AdkGeminiModel could not extract content parts from the last user message.',
      );
    }

    try {
      const stream = await this.chat.sendMessageStream(
        { model: this.modelName },
        inputParts,
        'adk-prompt-id', // TODO: Get prompt ID from context
        new AbortController().signal, // TODO: Pass signal
        LlmRole.SUBAGENT,
      );

      for await (const event of stream) {
        if (event.type === StreamEventType.CHUNK) {
          const chunk = event.value;
          const candidates = chunk.candidates;
          if (candidates && candidates.length > 0) {
            const parts = candidates[0].content?.parts;
            if (parts) {
              for (const part of parts) {
                if (part.text && !part.thought) {
                  // Yield partial content
                  yield {
                    content: {
                      role: 'model',
                      parts: [{ text: part.text }],
                    } as StructuralContent,
                    partial: true,
                  } as LlmResponse;
                }
                if (part.functionCall) {
                  // In ADK, tool calls can be yielded within the content parts
                  yield {
                    content: {
                      role: 'model',
                      parts: [
                        {
                          functionCall: {
                            name: part.functionCall.name,
                            args: part.functionCall.args,
                            id: part.functionCall.id,
                          },
                        },
                      ],
                    } as StructuralContent,
                  } as LlmResponse;
                }
              }
            }
          }
        }
      }
    } catch (e) {
      // Standardize on native Error objects as requested in the ADK improvements
      if (e instanceof Error) {
        throw e;
      }
      throw new Error(`AdkGeminiModel Error: ${String(e)}`);
    }
  }
}
