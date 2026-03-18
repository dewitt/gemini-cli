/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { InMemoryRunner, LlmAgent, getFunctionCalls, getFunctionResponses } from '@google/adk';
import type { Event as AdkAgentEvent } from '@google/adk';
import type { AgentSession, AgentSend, AgentEvent } from '../agent/types.js';
import type { AnyDeclarativeTool } from '../tools/tools.js';
import type { GeminiClient } from '../core/client.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { Config } from '../config/config.js';
import { AdkGeminiModel } from './adk-gemini-model.js';
import { AdkToolAdapter } from './adk-tool-adapter.js';

export interface AdkSessionDeps {
  client: GeminiClient;
  scheduler: Scheduler;
  toolRegistry: unknown; // Using unknown or importing ToolRegistry
  config: Config;
  promptId: string;
  streamId?: string;
  workspace: string;
}

export class AdkAgentSession implements AgentSession {
  private _events: AgentEvent[] = [];
  private _runner: InMemoryRunner;
  private _streamId: string;
  private _abortController = new AbortController();
  private _eventCounter = 0;
  private _streamDone = false;
  private _subscribers: Set<() => void> = new Set();
  private _sessionId: `${string}-${string}-${string}-${string}-${string}`;

  constructor(deps: AdkSessionDeps) {
    this._streamId = deps.streamId ?? crypto.randomUUID();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    this._sessionId = (deps.streamId ?? crypto.randomUUID()) as `${string}-${string}-${string}-${string}-${string}`;

    const adkModel = new AdkGeminiModel(
      deps.client,
      deps.promptId,
      deps.config.getModel(),
    );

    // Convert CLI tools to ADK tools
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const toolRegistry = deps.toolRegistry as {
      getAllTools: () => AnyDeclarativeTool[];
    };
    const adkTools = toolRegistry
      .getAllTools()
      .map((tool) => new AdkToolAdapter(tool, deps.scheduler));

    const agent = new LlmAgent({
      name: 'gemini_cli_agent',
      model: adkModel,
      instruction:
        'You are Gemini CLI. Run in the workspace: ' + deps.workspace,
      tools: adkTools,
    });

    this._runner = new InMemoryRunner({
      appName: 'gemini-cli',
      agent,
    });
  }

  async send(payload: AgentSend): Promise<{ streamId: string }> {
    const message = 'message' in payload ? payload.message : undefined;
    if (!message) {
      throw new Error('AdkAgentSession currently only supports message sends.');
    }

    // Combine text parts into a single string for ADK Content
    const textContent = message
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text: string }).text)
      .join('\n');

    this._runLoop(textContent).catch((err: unknown) => {
      this._emitErrorAndStreamEnd(err);
    });

    return { streamId: this._streamId };
  }

  async *stream(options?: {
    streamId?: string;
    eventId?: string;
  }): AsyncIterableIterator<AgentEvent> {
    let startIndex = 0;

    if (options?.eventId) {
      const idx = this._events.findIndex((e) => e.id === options.eventId);
      if (idx !== -1) {
        startIndex = idx + 1;
      }
    }

    for (let i = startIndex; i < this._events.length; i++) {
      yield this._events[i];
      if (this._events[i].type === 'stream_end') return;
    }

    if (this._streamDone) return;

    let replayedUpTo = this._events.length;
    while (true) {
      if (replayedUpTo >= this._events.length && !this._streamDone) {
        await new Promise<void>((resolve) => {
          if (this._events.length > replayedUpTo || this._streamDone) {
            resolve();
            return;
          }
          const handler = (): void => {
            this._subscribers.delete(handler);
            resolve();
          };
          this._subscribers.add(handler);
        });
      }

      while (replayedUpTo < this._events.length) {
        const event = this._events[replayedUpTo];
        replayedUpTo++;
        yield event;
        if (event.type === 'stream_end') return;
      }

      if (this._streamDone) return;
    }
  }

  async abort(): Promise<void> {
    this._abortController.abort();
  }

  get events(): AgentEvent[] {
    return this._events;
  }

  private async _runLoop(textContent: string): Promise<void> {
    try {
      this._appendAndNotify([
        this._makeInternalEvent('stream_start', { streamId: this._streamId }),
      ]);

      const sessionExists = await this._runner.sessionService.getSession({
        appName: 'gemini-cli',
        userId: 'local-user',
        sessionId: this._sessionId,
      });

      if (!sessionExists) {
        await this._runner.sessionService.createSession({
          appName: 'gemini-cli',
          userId: 'local-user',
          sessionId: this._sessionId,
        });
      }

      const stream = this._runner.runAsync({
        userId: 'local-user',
        sessionId: this._sessionId,
        newMessage: {
          role: 'user',
          parts: [{ text: textContent }],
        },
      });

      for await (const adkEvent of stream) {
        if (this._abortController.signal.aborted) {
          this._appendAndNotify([
            this._makeInternalEvent('stream_end', {
              streamId: this._streamId,
              reason: 'aborted',
            }),
          ]);
          this._markStreamDone();
          return;
        }

        const agentEvents = this._translateAdkEvent(adkEvent);
        if (agentEvents.length > 0) {
          this._appendAndNotify(agentEvents);
        }
      }

      this._appendAndNotify([
        this._makeInternalEvent('stream_end', {
          streamId: this._streamId,
          reason: 'completed',
        }),
      ]);
      this._markStreamDone();
    } catch (err: unknown) {
      this._emitErrorAndStreamEnd(err);
    }
  }

  private _translateAdkEvent(adkEvent: AdkAgentEvent): AgentEvent[] {
    const out: AgentEvent[] = [];

    // Text content
    if (adkEvent.content && adkEvent.content.parts) {
      const textParts = adkEvent.content.parts.filter((p: unknown) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
        return (p as any).text !== undefined;
      });
      if (textParts.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return
        const combinedText = textParts.map((p: any) => p.text).join('');
        if (combinedText) {
          out.push(
            this._makeInternalEvent('message', {
              role: 'agent',
              content: [{ type: 'text', text: combinedText }],
            }),
          );
        }
      }
    }

    // Function calls
    const functionCalls = getFunctionCalls(adkEvent);
    for (const call of functionCalls) {
      out.push(
        this._makeInternalEvent('tool_request', {
          requestId: call.id ?? crypto.randomUUID(),
          name: call.name,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          args: call.args as Record<string, unknown>,
        }),
      );
    }

    // Function responses
    const functionResponses = getFunctionResponses(adkEvent);
    for (const response of functionResponses) {
      out.push(
        this._makeInternalEvent('tool_response', {
          requestId: response.id,
          name: response.name,
          content: [
            { type: 'text', text: JSON.stringify(response.response) },
          ],
        }),
      );
    }

    // Errors
    if (adkEvent.errorCode || adkEvent.errorMessage) {
      out.push(
        this._makeInternalEvent('error', {
          status: 'INTERNAL',
          message: adkEvent.errorMessage ?? adkEvent.errorCode ?? 'Unknown error',
          fatal: true,
        }),
      );
    }

    return out;
  }

  private _markStreamDone(): void {
    this._streamDone = true;
    this._notifySubscribers();
  }

  private _appendAndNotify(events: AgentEvent[]): void {
    for (const event of events) {
      this._events.push(event);
    }
    if (events.length > 0) {
      this._notifySubscribers();
    }
  }

  private _notifySubscribers(): void {
    for (const handler of this._subscribers) {
      handler();
    }
  }

  private _emitErrorAndStreamEnd(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const errorEvent = this._makeInternalEvent('error', {
      status: 'INTERNAL',
      message,
      fatal: true,
    });
    const endEvent = this._makeInternalEvent('stream_end', {
      streamId: this._streamId,
      reason: 'failed',
    });
    this._appendAndNotify([errorEvent, endEvent]);
    this._markStreamDone();
  }

  private _makeInternalEvent(
    type: AgentEvent['type'],
    payload: Partial<AgentEvent>,
  ): AgentEvent {
    const id = `${this._streamId}-${this._eventCounter++}`;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return {
      ...payload,
      id,
      timestamp: new Date().toISOString(),
      streamId: this._streamId,
      type,
    } as AgentEvent;
  }
}
