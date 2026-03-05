/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion */

import { BaseTool } from '@google/adk';
import { type AnyDeclarativeTool } from '../tools/tools.js';

/**
 * Adapts a Gemini CLI DeclarativeTool to the ADK Tool interface.
 */
export class AdkToolAdapter extends BaseTool {
  constructor(private readonly innerTool: AnyDeclarativeTool) {
    super({ name: innerTool.name, description: innerTool.description });
  }

  override _getDeclaration(): any {
    return {
      name: this.innerTool.name,
      description: this.innerTool.description,
      parameters: this.innerTool.schema.parametersJsonSchema as any,
    };
  }

  async runAsync(request: { args: Record<string, unknown> }): Promise<unknown> {
    // 1. Build the invocation (this also performs validation)
    const invocation = this.innerTool.build(request.args as any);

    // 2. Execute the tool.
    const result = await invocation.execute(new AbortController().signal);

    // 3. Return the factual content meant for the LLM.
    return result.llmContent;
  }
}
