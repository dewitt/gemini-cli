/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalAgentExecutor } from '../agents/local-executor.js';
import { AdkAgentWrapper } from './adk-agent-wrapper.js';
import { AdkGeminiModel } from './adk-gemini-model.js';
import { makeFakeConfig } from '../test-utils/config.js';

describe('ADK Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should use AdkAgentWrapper when useAdk is enabled', async () => {
    const mockConfig = makeFakeConfig() as unknown as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    vi.spyOn(mockConfig, 'getUseAdk').mockReturnValue(true);

    const mockToolRegistry = {
      getAllTools: vi.fn().mockReturnValue([]),
      getAllToolNames: vi.fn().mockReturnValue([]),
    };
    vi.spyOn(mockConfig, 'getToolRegistry').mockReturnValue(mockToolRegistry);

    const mockAgentRegistry = {
      getAllAgentNames: vi.fn().mockReturnValue([]),
    };
    vi.spyOn(mockConfig, 'getAgentRegistry').mockReturnValue(mockAgentRegistry);

    const mockGeminiClient = {
      startChat: vi.fn().mockResolvedValue({}),
    };
    vi.spyOn(mockConfig, 'getGeminiClient').mockReturnValue(mockGeminiClient);

    const definition = {
      name: 'TestAdkAgent',
      description: 'Testing ADK integration',
      modelConfig: { model: 'test-model' },
      promptConfig: { systemPrompt: 'You are an ADK agent' },
      runConfig: { maxTurns: 5 },
    } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

    const agent = await LocalAgentExecutor.create(definition, mockConfig);

    expect(agent).toBeInstanceOf(AdkAgentWrapper);
    expect(agent.name).toBe('TestAdkAgent');
  });

  it('should support hyphenated agent names when useAdk is enabled', async () => {
    const mockConfig = makeFakeConfig() as unknown as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    vi.spyOn(mockConfig, 'getUseAdk').mockReturnValue(true);

    const mockToolRegistry = {
      getAllTools: vi.fn().mockReturnValue([]),
      getAllToolNames: vi.fn().mockReturnValue([]),
    };
    vi.spyOn(mockConfig, 'getToolRegistry').mockReturnValue(mockToolRegistry);

    const mockAgentRegistry = {
      getAllAgentNames: vi.fn().mockReturnValue([]),
    };
    vi.spyOn(mockConfig, 'getAgentRegistry').mockReturnValue(mockAgentRegistry);

    const mockGeminiClient = {
      startChat: vi.fn().mockResolvedValue({}),
    };
    vi.spyOn(mockConfig, 'getGeminiClient').mockReturnValue(mockGeminiClient);

    const definition = {
      name: 'test-kebab-agent',
      description: 'Testing kebab-case naming',
      modelConfig: { model: 'test-model' },
      promptConfig: { systemPrompt: 'You are an ADK agent' },
      runConfig: { maxTurns: 5 },
    } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

    const agent = await LocalAgentExecutor.create(definition, mockConfig);

    expect(agent).toBeInstanceOf(AdkAgentWrapper);
    expect(agent.name).toBe('test-kebab-agent');
  });

  it('should throw native Error in AdkGeminiModel when chat fails', async () => {
    const mockChat = {
      sendMessageStream: vi.fn().mockRejectedValue(new Error('API failure')),
    } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const model = new AdkGeminiModel(mockChat, 'test-model');

    const request = {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

    const generator = model.generateContentAsync(request);
    await expect(generator.next()).rejects.toThrow('API failure');
  });

  it('should use Default LocalAgentExecutor when useAdk is disabled', async () => {
    const mockConfig = makeFakeConfig() as unknown as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    vi.spyOn(mockConfig, 'getUseAdk').mockReturnValue(false);

    const mockToolRegistry = {
      getAllToolNames: vi.fn().mockReturnValue([]),
      sortTools: vi.fn(),
    };
    vi.spyOn(mockConfig, 'getToolRegistry').mockReturnValue(mockToolRegistry);

    const mockAgentRegistry = {
      getAllAgentNames: vi.fn().mockReturnValue([]),
    };
    vi.spyOn(mockConfig, 'getAgentRegistry').mockReturnValue(mockAgentRegistry);

    const definition = {
      name: 'TestLegacyAgent',
      description: 'Testing legacy path',
      modelConfig: { model: 'test-model' },
      promptConfig: { systemPrompt: 'You are a legacy agent' },
      runConfig: { maxTurns: 5 },
    } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

    const agent = await LocalAgentExecutor.create(definition, mockConfig);

    expect(agent).toBeInstanceOf(LocalAgentExecutor);
    expect(agent.name).toBe('TestLegacyAgent');
  });
});
