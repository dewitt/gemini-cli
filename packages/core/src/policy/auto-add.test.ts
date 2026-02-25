/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mocked,
} from 'vitest';
import * as fs from 'node:fs/promises';
import { createPolicyUpdater } from './config.js';
import {
  MessageBusType,
  type UpdatePolicy,
} from '../confirmation-bus/types.js';
import { coreEvents } from '../utils/events.js';
import type { PolicyEngine } from './policy-engine.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import type { Storage } from '../config/storage.js';

vi.mock('node:fs/promises');
vi.mock('../utils/events.js', () => ({
  coreEvents: {
    emitFeedback: vi.fn(),
  },
}));

describe('Policy Auto-add Safeguards', () => {
  let policyEngine: Mocked<PolicyEngine>;
  let messageBus: Mocked<MessageBus>;
  let storage: Mocked<Storage>;
  let updateCallback: (msg: UpdatePolicy) => Promise<void>;

  beforeEach(() => {
    policyEngine = {
      addRule: vi.fn(),
    } as unknown as Mocked<PolicyEngine>;
    messageBus = {
      subscribe: vi.fn((type, cb) => {
        if (type === MessageBusType.UPDATE_POLICY) {
          updateCallback = cb;
        }
      }),
      publish: vi.fn(),
    } as unknown as Mocked<MessageBus>;
    storage = {
      getWorkspacePoliciesDir: vi.fn().mockReturnValue('/tmp/policies'),
      getAutoSavedPolicyPath: vi
        .fn()
        .mockReturnValue('/tmp/policies/autosaved.toml'),
    } as unknown as Mocked<Storage>;

    const enoent = new Error('ENOENT');
    (enoent as NodeJS.ErrnoException).code = 'ENOENT';

    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.readFile).mockRejectedValue(enoent);
    vi.mocked(fs.open).mockResolvedValue({
      writeFile: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as fs.FileHandle);
    vi.mocked(fs.rename).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function wait() {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  it('should skip persistence for wildcard toolName', async () => {
    createPolicyUpdater(policyEngine, messageBus, storage);
    expect(updateCallback).toBeDefined();

    await updateCallback({
      type: MessageBusType.UPDATE_POLICY,
      toolName: '*',
      persist: true,
    });

    expect(fs.open).not.toHaveBeenCalled();
    expect(coreEvents.emitFeedback).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('Policy for all tools was not auto-saved'),
    );
  });

  it('should skip persistence for broad argsPattern (.*)', async () => {
    createPolicyUpdater(policyEngine, messageBus, storage);

    await updateCallback({
      type: MessageBusType.UPDATE_POLICY,
      toolName: 'test-tool',
      argsPattern: '.*',
      persist: true,
    });

    expect(fs.open).not.toHaveBeenCalled();
    expect(coreEvents.emitFeedback).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('was not auto-saved for safety reasons'),
    );
  });

  it('should allow persistence for specific argsPattern', async () => {
    createPolicyUpdater(policyEngine, messageBus, storage);

    await updateCallback({
      type: MessageBusType.UPDATE_POLICY,
      toolName: 'test-tool',
      argsPattern: '.*"file_path":"test.txt".*',
      persist: true,
    });

    await wait();

    expect(fs.open).toHaveBeenCalled();
    expect(fs.rename).toHaveBeenCalledWith(
      expect.stringContaining('autosaved.toml'),
      '/tmp/policies/autosaved.toml',
    );
  });

  it('should skip persistence for sensitive tool with no pattern', async () => {
    createPolicyUpdater(policyEngine, messageBus, storage);

    await updateCallback({
      type: MessageBusType.UPDATE_POLICY,
      toolName: 'shell',
      persist: true,
    });

    await wait();

    expect(fs.open).not.toHaveBeenCalled();
    expect(coreEvents.emitFeedback).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('Broad approval for "shell" was not auto-saved'),
    );
  });
});
