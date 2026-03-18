/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseTool } from '@google/adk';
import type { RunAsyncToolRequest } from '@google/adk';
import type { AnyDeclarativeTool } from '../tools/tools.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { FunctionDeclaration } from '@google/genai';
import { CoreToolCallStatus } from '../scheduler/types.js';

export class AdkToolAdapter extends BaseTool {
  private _cliTool: AnyDeclarativeTool;
  private _scheduler: Scheduler;

  constructor(cliTool: AnyDeclarativeTool, scheduler: Scheduler) {
    super({
      name: cliTool.name,
      description: cliTool.description,
      isLongRunning: false, // Could be derived if the CLI tool provides this signal
    });
    this._cliTool = cliTool;
    this._scheduler = scheduler;
  }

  override _getDeclaration(): FunctionDeclaration {
    return this._cliTool.getSchema();
  }

  async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    const callId = crypto.randomUUID(); // adk doesn't always expose callId in context, so we generate one
    const signal = new AbortController().signal;

    const completedCalls = await this._scheduler.schedule(
      {
        callId,
        name: this.name,
        args: request.args,
        isClientInitiated: false,
        prompt_id: 'adk-prompt',
      },
      signal,
    );

    const result = completedCalls[0];
    if (!result) {
      throw new Error(
        `Tool ${this.name} failed to return a result from the scheduler.`,
      );
    }

    if (result.status !== CoreToolCallStatus.Success) {
      if (result.response.error) {
        throw new Error(result.response.error.message);
      }
      throw new Error(`Tool ${this.name} failed with status ${result.status}`);
    }

    // The scheduler returns responseParts (which are @google/genai Part[]).
    // ADK tools typically return raw JSON which gets converted to a FunctionResponse,
    // or we can return the exact content. We will try returning the raw JSON object
    // since the model usually expects `{ status: 'success', ... }` format, but
    // Gemini handles function responses containing `Part` objects natively in genai SDK.
    // If the tool returned standard text parts, we map them into a JSON object.

    // Most CLI tools return a single text part with JSON in it, or just a string.
    const textPart = result.response.responseParts?.find(
      (p) => p.text !== undefined,
    )?.text;

    try {
      if (textPart) {
        return JSON.parse(textPart);
      }
    } catch {
      // If not valid JSON, return as-is
      return { output: textPart };
    }

    return result.response;
  }
}
