/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import type { Config } from '../config/config.js';
import { getCoreSystemPrompt } from '../core/prompts.js';
import type { LocalAgentDefinition } from './types.js';

const MainChatAgentSchema = z.object({
  response: z.string().describe('The final response from the agent.'),
});

/**
 * A definition for the main chat loop as an agent.
 */
export const MainChatAgentDefinition = (
  config: Config,
): LocalAgentDefinition<typeof MainChatAgentSchema> => ({
  kind: 'local',
  name: 'main-chat',
  displayName: 'Main Chat',
  description: 'The primary interactive chat agent.',
  inputConfig: {
    inputSchema: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: 'The user message.',
        },
      },
      required: ['request'],
    },
  },
  outputConfig: {
    outputName: 'result',
    description: 'The final answer or results of the task.',
    schema: MainChatAgentSchema,
  },
  modelConfig: {
    model: 'inherit',
  },
  get toolConfig() {
    // The main chat has access to all tools
    const tools = config.getToolRegistry().getAllToolNames();
    return {
      tools,
    };
  },
  get promptConfig() {
    return {
      systemPrompt: getCoreSystemPrompt(
        config,
        config.getUserMemory(),
        /*interactiveOverride=*/ true,
      ),
      query: '${request}',
    };
  },
  runConfig: {
    maxTimeMinutes: 30,
    maxTurns: 50,
  },
});
