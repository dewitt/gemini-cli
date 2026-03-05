/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Agent,
  AgentEvent,
  AgentRunOptions,
} from '../interfaces/agent.js';
import type { Config } from '../config/config.js';
import { reportError } from '../utils/errorReporting.js';
import { GeminiChat, StreamEventType } from '../core/geminiChat.js';
import {
  Type,
  type Content,
  type Part,
  type FunctionCall,
  type FunctionDeclaration,
  type Schema,
} from '@google/genai';
import { ToolRegistry } from '../tools/tool-registry.js';
import { CompressionStatus } from '../core/turn.js';
import type {
  ToolCallRequestInfo,
  ToolCallResponseInfo,
} from '../scheduler/types.js';
import { CoreToolCallStatus } from '../scheduler/types.js';
import { ChatCompressionService } from '../services/chatCompressionService.js';
import { getDirectoryContextString } from '../utils/environmentContext.js';
import { promptIdContext } from '../utils/promptIdContext.js';
import {
  logAgentStart,
  logAgentFinish,
  logRecoveryAttempt,
} from '../telemetry/loggers.js';
import {
  AgentStartEvent,
  AgentFinishEvent,
  RecoveryAttemptEvent,
} from '../telemetry/types.js';
import {
  AgentTerminateMode,
  DEFAULT_QUERY_STRING,
  DEFAULT_MAX_TURNS,
  DEFAULT_MAX_TIME_MINUTES,
  type LocalAgentDefinition,
  type AgentInputs,
  type OutputObject,
  type SubagentActivityEvent,
} from './types.js';
import { getErrorMessage } from '../utils/errors.js';
import { templateString } from './utils.js';
import { DEFAULT_GEMINI_MODEL, isAutoModel } from '../config/models.js';
import type { RoutingContext } from '../routing/routingStrategy.js';
import { parseThought } from '../utils/thoughtUtils.js';
import { type z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { debugLogger } from '../utils/debugLogger.js';
import { getModelConfigAlias } from './registry.js';
import { getVersion } from '../utils/version.js';
import { scheduleAgentTools } from './agent-scheduler.js';
import { DeadlineTimer } from '../utils/deadlineTimer.js';
import { formatUserHintsForModel } from '../utils/fastAckHelper.js';

export type ActivityCallback = (activity: SubagentActivityEvent) => void;

const TASK_COMPLETE_TOOL_NAME = 'complete_task';
const GRACE_PERIOD_MS = 60 * 1000; // 1 min

type AgentTurnResult =
  | {
      status: 'continue';
      nextMessage: Content;
    }
  | {
      status: 'stop';
      terminateReason: AgentTerminateMode;
      finalResult: string | null;
    };

/**
 * Executes an agent loop based on an {@link LocalAgentDefinition}.
 */
export class LegacyLoop<TOutput extends z.ZodTypeAny>
  implements Agent<AgentInputs, OutputObject>
{
  readonly definition: LocalAgentDefinition<TOutput>;

  readonly agentId: string;
  readonly toolRegistry: ToolRegistry;
  private readonly runtimeContext: Config;
  private readonly onActivity?: ActivityCallback;
  private readonly compressionService: ChatCompressionService;
  private readonly parentCallId?: string;
  private hasFailedCompressionAttempt = false;

  get name() {
    return this.definition.name;
  }
  get description() {
    return this.definition.description;
  }

  constructor(
    definition: LocalAgentDefinition<TOutput>,
    runtimeContext: Config,
    toolRegistry: ToolRegistry,
    parentPromptId: string | undefined,
    parentCallId: string | undefined,
    onActivity?: ActivityCallback,
  ) {
    this.definition = definition;
    this.runtimeContext = runtimeContext;
    this.toolRegistry = toolRegistry;
    this.onActivity = onActivity;
    this.compressionService = new ChatCompressionService();
    this.parentCallId = parentCallId;

    const randomIdPart = Math.random().toString(36).slice(2, 8);
    const parentPrefix = parentPromptId ? `${parentPromptId}-` : '';
    this.agentId = `${parentPrefix}${this.definition.name}-${randomIdPart}`;
  }

  private async tryCompressChat(
    chat: GeminiChat,
    prompt_id: string,
  ): Promise<void> {
    const model = this.definition.modelConfig.model ?? DEFAULT_GEMINI_MODEL;

    const { newHistory, info } = await this.compressionService.compress(
      chat,
      prompt_id,
      false,
      model,
      this.runtimeContext,
      this.hasFailedCompressionAttempt,
    );

    if (
      info.compressionStatus ===
      CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT
    ) {
      this.hasFailedCompressionAttempt = true;
    } else if (info.compressionStatus === CompressionStatus.COMPRESSED) {
      if (newHistory) {
        chat.setHistory(newHistory);
      }
    }
  }

  private checkTermination(
    turnCount: number,
    maxTurns: number,
  ): AgentTerminateMode | null {
    if (turnCount >= maxTurns) {
      return AgentTerminateMode.MAX_TURNS;
    }
    return null;
  }

  private async createChatObject(
    inputs: AgentInputs,
    tools: FunctionDeclaration[],
  ): Promise<GeminiChat> {
    const { promptConfig } = this.definition;

    if (!promptConfig.systemPrompt && !promptConfig.initialMessages) {
      throw new Error(
        'PromptConfig must define either `systemPrompt` or `initialMessages`.',
      );
    }

    const startHistory = this.applyTemplateToInitialMessages(
      promptConfig.initialMessages ?? [],
      inputs,
    );

    // Build system instruction from the templated prompt string.
    const systemInstruction = promptConfig.systemPrompt
      ? await this.buildSystemPrompt(inputs)
      : undefined;

    try {
      return new GeminiChat(
        this.runtimeContext,
        systemInstruction,
        [{ functionDeclarations: tools }],
        startHistory,
        undefined,
        undefined,
        'subagent',
      );
    } catch (e: unknown) {
      await reportError(
        e,
        `Error initializing Gemini chat for agent ${this.definition.name}.`,
        startHistory,
        'startChat',
      );
      // Re-throw as a more specific error after reporting.
      throw new Error(`Failed to create chat object: ${getErrorMessage(e)}`);
    }
  }

  /** Builds the system prompt from the agent definition and inputs. */
  private async buildSystemPrompt(inputs: AgentInputs): Promise<string> {
    const { promptConfig } = this.definition;
    if (!promptConfig.systemPrompt) {
      return '';
    }

    // Inject user inputs into the prompt template.
    let finalPrompt = templateString(promptConfig.systemPrompt, inputs);

    // Append environment context (CWD and folder structure).
    const dirContext = await getDirectoryContextString(this.runtimeContext);
    finalPrompt += `\n\n# Environment Context\n${dirContext}`;

    // Append standard rules for non-interactive execution.
    finalPrompt += `
Important Rules:
* You are running in a non-interactive mode. You CANNOT ask the user for input or clarification.
* Work systematically using available tools to complete your task.
* Always use absolute paths for file operations. Construct them using the provided "Environment Context".`;

    if (this.definition.outputSchema) {
      finalPrompt += `
* When you have completed your task, you MUST call the \`${TASK_COMPLETE_TOOL_NAME}\` tool with your structured output.
* Do not call any other tools in the same turn as \`${TASK_COMPLETE_TOOL_NAME}\`.
* This is the ONLY way to complete your mission. If you stop calling tools without calling this, you have failed.`;
    } else {
      finalPrompt += `
* When you have completed your task, you MUST call the \`${TASK_COMPLETE_TOOL_NAME}\` tool.
* You MUST include your final findings in the "result" parameter. This is how you return the necessary results for the task to be marked complete.
* Ensure your findings are comprehensive and follow any specific formatting requirements provided in your instructions.
* Do not call any other tools in the same turn as \`${TASK_COMPLETE_TOOL_NAME}\`.
* This is the ONLY way to complete your mission. If you stop calling tools without calling this, you have failed.`;
    }

    return finalPrompt;
  }

  /**
   * Applies template strings to initial messages.
   *
   * @param initialMessages The initial messages from the prompt config.
   * @param inputs The validated input parameters for this invocation.
   * @returns A new array of \`Content\` with templated strings.
   */
  private applyTemplateToInitialMessages(
    initialMessages: Content[],
    inputs: AgentInputs,
  ): Content[] {
    return initialMessages.map((content) => {
      const newParts = (content.parts ?? []).map((part) => {
        if ('text' in part && part.text !== undefined) {
          return { text: templateString(part.text, inputs) };
        }
        return part;
      });
      return { ...content, parts: newParts };
    });
  }

  private prepareToolsList(): FunctionDeclaration[] {
    const toolsList: FunctionDeclaration[] = [];
    const { toolConfig, outputConfig } = this.definition;

    if (toolConfig) {
      const toolNamesToLoad: string[] = [];
      for (const toolRef of toolConfig.tools) {
        if (typeof toolRef === 'string') {
          toolNamesToLoad.push(toolRef);
        } else if (typeof toolRef === 'object' && 'schema' in toolRef) {
          // Tool instance with an explicit schema property.
          toolsList.push(toolRef.schema);
        } else {
          // Raw `FunctionDeclaration` object.
          toolsList.push(toolRef);
        }
      }
      // Add schemas from tools that were registered by name.
      toolsList.push(
        ...this.toolRegistry.getFunctionDeclarationsFiltered(toolNamesToLoad),
      );
    } else {
      // If no tools explicitly configured, default to all available tools
      const allNames = this.toolRegistry.getAllToolNames();
      toolsList.push(...this.toolRegistry.getFunctionDeclarationsFiltered(allNames));
    }

    // Always inject complete_task.
    // Configure its schema based on whether output is expected.
    const completeTool: FunctionDeclaration = {
      name: TASK_COMPLETE_TOOL_NAME,
      description: outputConfig
        ? 'Call this tool to submit your final answer and complete the task. This is the ONLY way to finish.'
        : 'Call this tool to submit your final findings and complete the task. This is the ONLY way to finish.',
      parameters: {
        type: Type.OBJECT,
        properties: {},
        required: [],
      },
    };

    if (outputConfig) {
      const jsonSchema = zodToJsonSchema(outputConfig.schema);
      const {
        $schema: _$schema,
        definitions: _definitions,
        ...schema
      } = jsonSchema;
      completeTool.parameters!.properties![outputConfig.outputName] =
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        schema as Schema;
      completeTool.parameters!.required!.push(outputConfig.outputName);
    } else {
      completeTool.parameters!.properties!['result'] = {
        type: Type.STRING,
        description:
          'Your final results or findings to return to the orchestrator. ' +
          'Ensure this is comprehensive and follows any formatting requested in your instructions.',
      };
      completeTool.parameters!.required!.push('result');
    }

    toolsList.push(completeTool);

    return toolsList;
  }

  private emitActivity(
    type: string,
    data: Record<string, unknown>,
  ) {
    if (!this.onActivity) return;
    this.onActivity({
      isSubagentActivityEvent: true,
      agentName: this.definition.name,
      type: type as SubagentActivityEvent['type'],
      data,
    });
  }

  /**
   * Helper function to encapsulate the complex model calling and error handling logic,
   * yielding specific structured agent events.
   */
  private async *callModel(
    chat: GeminiChat,
    requestParams: Content,
    signal: AbortSignal,
    prompt_id: string,
  ): AsyncGenerator<
    AgentEvent,
    { functionCalls: FunctionCall[]; textResponse: string }
  > {
    // Generate context for routing based on configured required tools and model config logic
    let modelInstanceConfigAlias = this.definition.modelConfig.model;
    const routingContext: RoutingContext = {
      requiredTools: this.definition.toolConfig?.requiredTools,
    };
    if (!modelInstanceConfigAlias || isAutoModel(modelInstanceConfigAlias)) {
      const suggestedModel =
        chat.runtimeContext
          .getModelRouterService()
          ?.routeToModel(routingContext);
      if (suggestedModel) {
        modelInstanceConfigAlias = suggestedModel.name;
        chat.overrideModelConfig(modelInstanceConfigAlias);
      }
    }

    try {
      this.emitActivity('CALL_START', { model: modelInstanceConfigAlias });

      const stream = await chat.sendMessageStream(requestParams, {
        signal,
        prompt_id,
        enableProgressEvents: true,
      });

      let textBuffer = '';
      const functionCalls: FunctionCall[] = [];
      let thoughtBuffer = '';

      chat.runtimeContext
        .getMessageBus()
        .emit('model-streaming-started', { promptId: prompt_id });

      for await (const chunk of stream) {
        if (chunk.type === StreamEventType.CONTENT) {
          const modelTurn = chunk.content;
          for (const item of modelTurn.parts) {
            if (item.functionCall) {
              functionCalls.push(item.functionCall);
            }
            if (item.text) {
              textBuffer += item.text;
            }
          }

          if (textBuffer.length > 0) {
            const parsed = parseThought(textBuffer);

            // Yield new thought fragments
            if (parsed.thought !== thoughtBuffer) {
              const diff = parsed.thought.substring(thoughtBuffer.length);
              this.emitActivity('THOUGHT_CHUNK', { text: diff });
              yield { type: 'thought', content: diff };
              thoughtBuffer = parsed.thought;
            }

            // Yield new final content chunks
            if (parsed.content) {
              yield { type: 'content', content: parsed.content };
              this.emitActivity('RESPONSE_CHUNK', { text: parsed.content });
            }
          }
        }
      }

      this.emitActivity('CALL_END', {
        result: textBuffer,
        callCount: functionCalls.length,
      });

      return { functionCalls, textResponse: textBuffer };
    } catch (e: unknown) {
      if (signal.aborted) {
        throw new Error('callModel interrupted or timed out.');
      }
      const message = `Agent model call encountered a fatal error: ${getErrorMessage(e)}`;
      this.emitActivity('ERROR', {
        error: message,
        context: 'model_call_fatal',
        details: e instanceof Error ? e.stack : undefined,
      });
      // Important to report errors originating from agents.
      reportError(e);
      throw e;
    }
  }

  /**
   * Processes the function calls requested by the model.
   */
  private async *processFunctionCalls(
    functionCalls: FunctionCall[],
    signal: AbortSignal,
    promptId: string,
    onWaitingForConfirmation?: (waiting: boolean) => void,
  ): AsyncGenerator<
    AgentEvent,
    {
      nextMessage: Content;
      submittedOutput?: string;
      taskCompleted: boolean;
      aborted?: boolean;
    }
  > {
    const taskCompleteCall = functionCalls.find(
      (call) => call.name === TASK_COMPLETE_TOOL_NAME,
    );
    if (taskCompleteCall) {
      let submittedOutput: string | undefined;

      if (taskCompleteCall.args) {
        if (this.definition.outputConfig) {
          const { outputName, schema } = this.definition.outputConfig;
          const outputData = taskCompleteCall.args[outputName];
          try {
            const parsedData = schema.parse(outputData);
            if (this.definition.processOutput) {
              submittedOutput = this.definition.processOutput(parsedData);
            } else {
              submittedOutput = JSON.stringify(parsedData);
            }
          } catch (error) {
            throw new Error(
              `Failed to validate output against configured schema: ${error}`,
            );
          }
        } else if ('result' in taskCompleteCall.args) {
          submittedOutput = taskCompleteCall.args.result as string;
        }
      }

      this.emitActivity('CALL_END', {
        result: 'complete_task',
        callCount: 1,
      });

      return {
        nextMessage: { role: 'user', parts: [] },
        submittedOutput,
        taskCompleted: true,
      };
    }

    const toolResponses: Part[] = [];
    let aborted = false;

    // Build the request info structures to pass to scheduler
    const requestInfos: ToolCallRequestInfo[] = functionCalls.map((call) => {
      // The cast to string is required because call.id doesn't exist on genai FunctionCall
      // but might be manually added dynamically elsewhere? Let's use string.
      const rawCall = call as unknown as { id?: string };
      return {
        callId:
          rawCall.id ||
          `synthetic-call-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: call.name,
        args: call.args || {},
        prompt_id: promptId,
        isClientInitiated: false,
      };
    });

    // Start tracking the request externally (UI, etc.)
    for (const info of requestInfos) {
      this.emitActivity('TOOL_CALL', {
        toolName: info.name,
        callArgs: info.args,
      });
      yield { type: 'tool_call', call: info };
    }

    try {
      const results = await scheduleAgentTools(
        requestInfos,
        this.toolRegistry,
        this.agentId,
        this.runtimeContext,
        onWaitingForConfirmation,
      );

      for (let i = 0; i < results.length; i++) {
        const result = results[i]!;

        if (result.status === CoreToolCallStatus.Cancelled) {
          aborted = true;
          const argsString = JSON.stringify(result.request.args, null);
          const reportStr = `The user chose to abort the agent execution while attempting to run: ${result.request.name}(${argsString})`;

          this.emitActivity('ERROR', {
            context: 'tool_call',
            name: result.request.name,
            error: 'User rejected tool execution.',
          });

          throw new Error(reportStr);
        }

        toolResponses.push(...result.response.responseParts);

        this.emitActivity('TOOL_CALL_END', {
          name: result.request.name,
          error: result.response.error?.name,
          durationMs: result.durationMs,
        });

        // Yield result event back to UI
        yield {
          type: 'tool_result',
          result: result.response,
        };
      }
    } catch (error) {
      throw error;
    }

    return {
      nextMessage: {
        role: 'user',
        parts: toolResponses,
      },
      taskCompleted: false,
      aborted,
    };
  }

  /**
   * Executes a single turn of the agent's logic.
   */
  private async *executeTurn(
    chat: GeminiChat,
    currentMessage: Content,
    turnCounter: number,
    combinedSignal: AbortSignal,
    timeoutSignal: AbortSignal,
    onWaitingForConfirmation?: (waiting: boolean) => void,
  ): AsyncGenerator<AgentEvent, AgentTurnResult> {
    const promptId = `${this.agentId}#${turnCounter}`;

    await this.tryCompressChat(chat, promptId);

    let modelResult:
      | { functionCalls: FunctionCall[]; textResponse: string }
      | undefined;

    const modelStream = promptIdContext.run(promptId, () =>
      this.callModel(chat, currentMessage, combinedSignal, promptId),
    );

    const modelIterator = modelStream[Symbol.asyncIterator]();
    let modelNext = await modelIterator.next();
    while (!modelNext.done) {
      yield modelNext.value;
      modelNext = await modelIterator.next();
    }
    modelResult = modelNext.value;

    if (!modelResult) {
      debugLogger.error(
        `[LegacyLoop] modelResult is undefined after generator finished.`,
      );
      modelResult = { functionCalls: [], textResponse: '' };
    }

    const { functionCalls } = modelResult;

    if (combinedSignal.aborted) {
      const terminateReason = timeoutSignal.aborted
        ? AgentTerminateMode.TIMEOUT
        : AgentTerminateMode.ABORTED;
      return {
        status: 'stop',
        terminateReason,
        finalResult: null,
      };
    }

    if (functionCalls.length === 0) {
      const err = `Agent stopped calling tools but did not call '${TASK_COMPLETE_TOOL_NAME}' to finalize the session.`;
      this.emitActivity('ERROR', {
        error: err,
        context: 'protocol_violation',
      });
      yield { type: 'error', error: new Error(err) };
      return {
        status: 'stop',
        terminateReason: AgentTerminateMode.ERROR_NO_COMPLETE_TASK_CALL,
        finalResult: null,
      };
    }

    const processStream = this.processFunctionCalls(
      functionCalls,
      combinedSignal,
      promptId,
      onWaitingForConfirmation,
    );

    const processIterator = processStream[Symbol.asyncIterator]();
    let processNext = await processIterator.next();
    while (!processNext.done) {
      yield processNext.value;
      processNext = await processIterator.next();
    }

    if (!processNext.value) {
      throw new Error(
        'processFunctionCalls finished without returning a result.',
      );
    }

    const { nextMessage, submittedOutput, taskCompleted, aborted } =
      processNext.value;

    if (aborted) {
      return {
        status: 'stop',
        terminateReason: AgentTerminateMode.ABORTED,
        finalResult: null,
      };
    }

    if (taskCompleted) {
      const finalResult = submittedOutput ?? 'Task completed successfully.';
      return {
        status: 'stop',
        terminateReason: AgentTerminateMode.GOAL,
        finalResult,
      };
    }

    return {
      status: 'continue',
      nextMessage,
    };
  }

  private getFinalWarningMessage(
    reason:
      | AgentTerminateMode.TIMEOUT
      | AgentTerminateMode.MAX_TURNS
      | AgentTerminateMode.ERROR_NO_COMPLETE_TASK_CALL,
  ): string {
    let explanation = '';
    switch (reason) {
      case AgentTerminateMode.TIMEOUT:
        explanation = 'You have exceeded the time limit.';
        break;
      case AgentTerminateMode.MAX_TURNS:
        explanation = 'You have exceeded the maximum number of turns.';
        break;
      case AgentTerminateMode.ERROR_NO_COMPLETE_TASK_CALL:
        explanation = 'You have stopped calling tools without finishing.';
        break;
      default:
        throw new Error(`Unknown terminate reason: ${reason}`);
    }
    return `${explanation} You have one final chance to complete the task with a short grace period. You MUST call \`${TASK_COMPLETE_TOOL_NAME}\` immediately with your best answer and explain that your investigation was interrupted. Do not call any other tools.`;
  }

  private async *executeFinalWarningTurn(
    chat: GeminiChat,
    turnCounter: number,
    reason:
      | AgentTerminateMode.TIMEOUT
      | AgentTerminateMode.MAX_TURNS
      | AgentTerminateMode.ERROR_NO_COMPLETE_TASK_CALL,
    externalSignal: AbortSignal,
    onWaitingForConfirmation?: (waiting: boolean) => void,
  ): AsyncGenerator<AgentEvent, string | null> {
    this.emitActivity('THOUGHT_CHUNK', {
      text: `Execution limit reached (${reason}). Attempting one final recovery turn with a grace period.`,
    });
    yield {
      type: 'thought',
      content: `Execution limit reached (${reason}). Attempting one final recovery turn.`,
    };

    const recoveryStartTime = Date.now();
    let success = false;

    const gracePeriodMs = GRACE_PERIOD_MS;
    const graceTimeoutController = new AbortController();
    const graceTimeoutId = setTimeout(
      () => graceTimeoutController.abort(new Error('Grace period timed out.')),
      gracePeriodMs,
    );

    try {
      const recoveryMessage: Content = {
        role: 'user',
        parts: [{ text: this.getFinalWarningMessage(reason) }],
      };

      const combinedSignal = AbortSignal.any([
        externalSignal,
        graceTimeoutController.signal,
      ]);

      const turnStream = this.executeTurn(
        chat,
        recoveryMessage,
        turnCounter,
        combinedSignal,
        graceTimeoutController.signal,
        onWaitingForConfirmation,
      );

      const turnIterator = turnStream[Symbol.asyncIterator]();
      let turnNext = await turnIterator.next();
      while (!turnNext.done) {
        yield turnNext.value;
        turnNext = await turnIterator.next();
      }
      const turnResult = turnNext.value;

      if (
        turnResult.status === 'stop' &&
        turnResult.terminateReason === AgentTerminateMode.GOAL
      ) {
        this.emitActivity('THOUGHT_CHUNK', {
          text: 'Graceful recovery succeeded.',
        });
        yield { type: 'thought', content: 'Graceful recovery succeeded.' };
        success = true;
        return turnResult.finalResult ?? 'Task completed during grace period.';
      }

      const errorMsg = `Graceful recovery attempt failed. Reason: ${turnResult.status}`;
      this.emitActivity('ERROR', {
        error: errorMsg,
        context: 'recovery_turn',
      });
      yield { type: 'error', error: new Error(errorMsg) };
      return null;
    } catch (error) {
      const errorMsg = `Graceful recovery attempt failed: ${String(error)}`;
      this.emitActivity('ERROR', {
        error: errorMsg,
        context: 'recovery_turn',
      });
      yield { type: 'error', error: new Error(errorMsg) };
      return null;
    } finally {
      clearTimeout(graceTimeoutId);
      logRecoveryAttempt(
        this.runtimeContext,
        new RecoveryAttemptEvent(
          this.agentId,
          this.definition.name,
          reason,
          Date.now() - recoveryStartTime,
          success,
          turnCounter,
        ),
      );
    }
  }

  async *runAsync(
    inputs: AgentInputs,
    options?: AgentRunOptions,
  ): AsyncGenerator<AgentEvent, OutputObject> {
    const signal = options?.signal ?? new AbortController().signal;
    const startTime = Date.now();
    let turnCounter = 0;
    let terminateReason: AgentTerminateMode = AgentTerminateMode.ERROR;
    let finalResult: string | null = null;

    const maxTimeMinutes =
      options?.maxTime ??
      this.definition.runConfig.maxTimeMinutes ??
      DEFAULT_MAX_TIME_MINUTES;
    const maxTurns =
      options?.maxTurns ??
      this.definition.runConfig.maxTurns ??
      DEFAULT_MAX_TURNS;

    const deadlineTimer = new DeadlineTimer(
      maxTimeMinutes * 60 * 1000,
      'Agent timed out.',
    );

    const onWaitingForConfirmation = (waiting: boolean) => {
      if (waiting) {
        deadlineTimer.pause();
      } else {
        deadlineTimer.resume();
      }
    };

    const combinedSignal = AbortSignal.any([signal, deadlineTimer.signal]);

    logAgentStart(
      this.runtimeContext,
      new AgentStartEvent(this.agentId, this.definition.name),
    );

    let chat: GeminiChat | undefined;
    let tools: FunctionDeclaration[] | undefined;
    try {
      const augmentedInputs = {
        ...inputs,
        cliVersion: await getVersion(),
        activeModel: this.runtimeContext.getActiveModel(),
        today: new Date().toLocaleDateString(),
      };

      tools = this.prepareToolsList();
      chat = await this.createChatObject(augmentedInputs, tools);
      const query = this.definition.promptConfig.query
        ? templateString(this.definition.promptConfig.query, augmentedInputs)
        : DEFAULT_QUERY_STRING;

      const pendingHintsQueue: string[] = [];
      const hintListener = (hint: string) => {
        pendingHintsQueue.push(hint);
      };

      const startIndex =
        this.runtimeContext.userHintService.getLatestHintIndex();
      this.runtimeContext.userHintService.onUserHint(hintListener);

      try {
        const initialHints =
          this.runtimeContext.userHintService.getUserHintsAfter(startIndex);
        const formattedInitialHints = formatUserHintsForModel(initialHints);

        let currentMessage: Content = formattedInitialHints
          ? {
              role: 'user',
              parts: [{ text: formattedInitialHints }, { text: query }],
            }
          : { role: 'user', parts: [{ text: query }] };

        while (true) {
          const reason = this.checkTermination(turnCounter, maxTurns);
          if (reason) {
            terminateReason = reason;
            break;
          }

          if (combinedSignal.aborted) {
            terminateReason = deadlineTimer.signal.aborted
              ? AgentTerminateMode.TIMEOUT
              : AgentTerminateMode.ABORTED;
            break;
          }

          const turnStream = this.executeTurn(
            chat,
            currentMessage,
            turnCounter++,
            combinedSignal,
            deadlineTimer.signal,
            onWaitingForConfirmation,
          );

          const turnIterator = turnStream[Symbol.asyncIterator]();
          let turnNext = await turnIterator.next();
          while (!turnNext.done) {
            yield turnNext.value;
            turnNext = await turnIterator.next();
          }
          const turnResult = turnNext.value;

          if (turnResult.status === 'stop') {
            terminateReason = turnResult.terminateReason;
            if (turnResult.finalResult) {
              finalResult = turnResult.finalResult;
            }
            break;
          }

          currentMessage = turnResult.nextMessage;

          if (pendingHintsQueue.length > 0) {
            const hintsToProcess = [...pendingHintsQueue];
            pendingHintsQueue.length = 0;
            const formattedHints = formatUserHintsForModel(hintsToProcess);
            if (formattedHints) {
              currentMessage.parts ??= [];
              currentMessage.parts.unshift({ text: formattedHints });
            }
          }
        }
      } finally {
        this.runtimeContext.userHintService.offUserHint(hintListener);
      }

      if (
        terminateReason !== AgentTerminateMode.ERROR &&
        terminateReason !== AgentTerminateMode.ABORTED &&
        terminateReason !== AgentTerminateMode.GOAL
      ) {
        const recoveryStream = this.executeFinalWarningTurn(
          chat,
          turnCounter,
          terminateReason,
          signal,
          onWaitingForConfirmation,
        );

        const recoveryIterator = recoveryStream[Symbol.asyncIterator]();
        let recoveryNext = await recoveryIterator.next();
        while (!recoveryNext.done) {
          yield recoveryNext.value;
          recoveryNext = await recoveryIterator.next();
        }
        const recoveryResult = recoveryNext.value;

        if (recoveryResult !== null) {
          terminateReason = AgentTerminateMode.GOAL;
          finalResult = recoveryResult;
        } else {
          if (terminateReason === AgentTerminateMode.TIMEOUT) {
            finalResult = `Agent timed out after ${maxTimeMinutes} minutes.`;
            this.emitActivity('ERROR', {
              error: finalResult,
              context: 'timeout',
            });
            yield { type: 'error', error: new Error(finalResult) };
          } else if (terminateReason === AgentTerminateMode.MAX_TURNS) {
            finalResult = `Agent reached max turns limit (${maxTurns}).`;
            this.emitActivity('ERROR', {
              error: finalResult,
              context: 'max_turns',
            });
            yield { type: 'error', error: new Error(finalResult) };
          } else if (
            terminateReason === AgentTerminateMode.ERROR_NO_COMPLETE_TASK_CALL
          ) {
            finalResult =
              finalResult ||
              `Agent stopped calling tools but did not call '${TASK_COMPLETE_TOOL_NAME}'.`;
            this.emitActivity('ERROR', {
              error: finalResult,
              context: 'protocol_violation',
            });
            yield { type: 'error', error: new Error(finalResult) };
          }
        }
      }

      if (terminateReason === AgentTerminateMode.GOAL) {
        const output = {
          result: finalResult || 'Task completed.',
          terminate_reason: terminateReason,
        };
        yield { type: 'finished', output };
        return output;
      }

      const output = {
        result:
          finalResult || 'Agent execution was terminated before completion.',
        terminate_reason: terminateReason,
      };
      yield { type: 'finished', output };
      return output;
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === 'AbortError' &&
        deadlineTimer.signal.aborted &&
        !signal.aborted
      ) {
        terminateReason = AgentTerminateMode.TIMEOUT;

        if (chat && tools) {
          const recoveryStream = this.executeFinalWarningTurn(
            chat,
            turnCounter,
            AgentTerminateMode.TIMEOUT,
            signal,
            onWaitingForConfirmation,
          );

          const recoveryIterator = recoveryStream[Symbol.asyncIterator]();
          let recoveryNext = await recoveryIterator.next();
          while (!recoveryNext.done) {
            yield recoveryNext.value;
            recoveryNext = await recoveryIterator.next();
          }
          const recoveryResult = recoveryNext.value;

          if (recoveryResult !== null) {
            terminateReason = AgentTerminateMode.GOAL;
            finalResult = recoveryResult;
            const output = {
              result: finalResult,
              terminate_reason: terminateReason,
            };
            yield { type: 'finished', output };
            return output;
          }
        }

        finalResult = `Agent timed out after ${maxTimeMinutes} minutes.`;
        this.emitActivity('ERROR', {
          error: finalResult,
          context: 'timeout',
        });
        yield { type: 'error', error: new Error(finalResult) };
        const output = {
          result: finalResult,
          terminate_reason: terminateReason,
        };
        yield { type: 'finished', output };
        return output;
      }

      this.emitActivity('ERROR', { error: String(error) });
      yield {
        type: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
      };
      throw error;
    } finally {
      deadlineTimer.abort();
      logAgentFinish(
        this.runtimeContext,
        new AgentFinishEvent(
          this.agentId,
          this.definition.name,
          Date.now() - startTime,
          turnCounter,
          terminateReason,
        ),
      );
    }
  }

  async *runEphemeral(
    inputs: AgentInputs,
    options?: AgentRunOptions,
  ): AsyncGenerator<AgentEvent, OutputObject> {
    return yield* this.runAsync(inputs, options);
  }

  async runLegacy(
    inputs: AgentInputs,
    signal: AbortSignal,
  ): Promise<OutputObject> {
    const generator = this.runAsync(inputs, { signal });
    let result: IteratorResult<AgentEvent, OutputObject>;

    while (true) {
      result = await generator.next();
      if (result.done) {
        return result.value;
      }
    }
  }
}
