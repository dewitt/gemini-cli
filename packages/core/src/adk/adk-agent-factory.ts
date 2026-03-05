/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { LlmAgent } from '@google/adk';
import type { Config } from '../config/config.js';
import type {
  LocalAgentDefinition,
  AgentInputs,
  OutputObject,
} from '../agents/types.js';
import type { Agent } from '../interfaces/agent.js';
import { AdkGeminiModel } from './adk-gemini-model.js';
import { AdkToolAdapter } from './adk-tool-adapter.js';
import { AdkAgentWrapper } from './adk-agent-wrapper.js';
import { type z } from 'zod';
import { debugLogger } from '../utils/debugLogger.js';

/**
 * Factory for creating ADK-based agents that are compatible with the Gemini CLI.
 */
export class AdkAgentFactory {
  static async create<TOutput extends z.ZodTypeAny>(
    definition: LocalAgentDefinition<TOutput>,
    runtimeContext: Config,
  ): Promise<Agent<AgentInputs, OutputObject>> {
    debugLogger.log(`[AdkAgentFactory] Creating ADK agent: ${definition.name}`);
    const chat = await runtimeContext.getGeminiClient().startChat();
    const modelName =
      definition.modelConfig.model === 'inherit'
        ? runtimeContext.getActiveModel()
        : definition.modelConfig.model || runtimeContext.getActiveModel();

    const model = new AdkGeminiModel(chat, modelName);

    const toolRegistry = runtimeContext.getToolRegistry();
    const adkTools = toolRegistry
      .getAllTools()
      .map((tool) => new AdkToolAdapter(tool));

    const adkAgent = new LlmAgent({
      name: definition.name,
      description: definition.description,
      model,
      tools: adkTools,
      instruction: definition.promptConfig.systemPrompt || '',
    });

    return new AdkAgentWrapper(adkAgent);
  }
}
