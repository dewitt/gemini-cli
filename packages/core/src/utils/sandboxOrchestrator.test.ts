/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { SandboxOrchestrator } from './sandboxOrchestrator.js';
import { EventEmitter } from 'node:events';
import type { SandboxConfig } from '../config/config.js';

vi.mock('node:child_process');
vi.mock('../index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../index.js')>();
  return {
    ...actual,
    debugLogger: {
      log: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    },
    coreEvents: {
      emitFeedback: vi.fn(),
    },
    LOCAL_DEV_SANDBOX_IMAGE_NAME: 'gemini-cli-sandbox',
  };
});

describe('SandboxOrchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getContainerRunArgs', () => {
    it('should build basic run args', () => {
      const config: SandboxConfig = {
        command: 'docker',
        image: 'some-image',
      };
      const args = SandboxOrchestrator.getContainerRunArgs(config, '/work');
      expect(args).toEqual([
        'run',
        '-i',
        '--rm',
        '--init',
        '--workdir',
        '/work',
      ]);
    });

    it('should include flags from config', () => {
      const config: SandboxConfig = {
        command: 'docker',
        image: 'some-image',
        flags: '--privileged --net=host',
      };
      const args = SandboxOrchestrator.getContainerRunArgs(config, '/work');
      expect(args).toEqual([
        'run',
        '-i',
        '--rm',
        '--init',
        '--workdir',
        '/work',
        '--privileged',
        '--net=host',
      ]);
    });

    it('should include flags from environment if config flags are missing', () => {
      const config: SandboxConfig = {
        command: 'docker',
        image: 'some-image',
      };
      const args = SandboxOrchestrator.getContainerRunArgs(
        config,
        '/work',
        '--env FOO=bar',
      );
      expect(args).toEqual([
        'run',
        '-i',
        '--rm',
        '--init',
        '--workdir',
        '/work',
        '--env',
        'FOO=bar',
      ]);
    });

    it('should expand environment variables in flags', () => {
      process.env['TEST_VAR'] = 'test-value';
      const config: SandboxConfig = {
        command: 'docker',
        image: 'some-image',
        flags: '--label user=$TEST_VAR',
      };
      const args = SandboxOrchestrator.getContainerRunArgs(config, '/work');
      expect(args).toEqual([
        'run',
        '-i',
        '--rm',
        '--init',
        '--workdir',
        '/work',
        '--label',
        'user=test-value',
      ]);
    });
  });

  describe('ensureSandboxImageIsPresent', () => {
    it('should return true if image exists locally', async () => {
      interface MockProcessWithStdout extends EventEmitter {
        stdout: EventEmitter;
      }
      const mockImageCheckProcess = new EventEmitter() as MockProcessWithStdout;
      mockImageCheckProcess.stdout = new EventEmitter();
      vi.mocked(spawn).mockImplementationOnce(() => {
        setTimeout(() => {
          mockImageCheckProcess.stdout.emit('data', Buffer.from('image-id'));
          mockImageCheckProcess.emit('close', 0);
        }, 1);
        return mockImageCheckProcess as unknown as ReturnType<typeof spawn>;
      });

      const result = await SandboxOrchestrator.ensureSandboxImageIsPresent(
        'docker',
        'some-image',
      );
      expect(result).toBe(true);
      expect(spawn).toHaveBeenCalledWith('docker', [
        'images',
        '-q',
        'some-image',
      ]);
    });

    it('should pull image if missing and return true on success', async () => {
      // 1. Image check fails (returns empty stdout)
      interface MockProcessWithStdout extends EventEmitter {
        stdout: EventEmitter;
      }
      const mockImageCheckProcess1 =
        new EventEmitter() as MockProcessWithStdout;
      mockImageCheckProcess1.stdout = new EventEmitter();
      vi.mocked(spawn).mockImplementationOnce(() => {
        setTimeout(() => {
          mockImageCheckProcess1.emit('close', 0);
        }, 1);
        return mockImageCheckProcess1 as unknown as ReturnType<typeof spawn>;
      });

      // 2. Pull image succeeds
      interface MockChildProcess extends EventEmitter {
        stdout: EventEmitter;
        stderr: EventEmitter;
      }
      const mockPullProcess = new EventEmitter() as MockChildProcess;
      mockPullProcess.stdout = new EventEmitter();
      mockPullProcess.stderr = new EventEmitter();
      vi.mocked(spawn).mockImplementationOnce(() => {
        setTimeout(() => {
          mockPullProcess.emit('close', 0);
        }, 1);
        return mockPullProcess as unknown as ReturnType<typeof spawn>;
      });

      // 3. Image check succeeds
      const mockImageCheckProcess2 =
        new EventEmitter() as MockProcessWithStdout;
      mockImageCheckProcess2.stdout = new EventEmitter();
      vi.mocked(spawn).mockImplementationOnce(() => {
        setTimeout(() => {
          mockImageCheckProcess2.stdout.emit('data', Buffer.from('image-id'));
          mockImageCheckProcess2.emit('close', 0);
        }, 1);
        return mockImageCheckProcess2 as unknown as ReturnType<typeof spawn>;
      });

      const result = await SandboxOrchestrator.ensureSandboxImageIsPresent(
        'docker',
        'some-image',
      );
      expect(result).toBe(true);
      expect(spawn).toHaveBeenCalledWith(
        'docker',
        ['pull', 'some-image'],
        expect.any(Object),
      );
    });

    it('should return false if image pull fails', async () => {
      // 1. Image check fails
      interface MockProcessWithStdout extends EventEmitter {
        stdout: EventEmitter;
      }
      const mockImageCheckProcess1 =
        new EventEmitter() as MockProcessWithStdout;
      mockImageCheckProcess1.stdout = new EventEmitter();
      vi.mocked(spawn).mockImplementationOnce(() => {
        setTimeout(() => {
          mockImageCheckProcess1.emit('close', 0);
        }, 1);
        return mockImageCheckProcess1 as unknown as ReturnType<typeof spawn>;
      });

      // 2. Pull image fails
      interface MockChildProcess extends EventEmitter {
        stdout: EventEmitter;
        stderr: EventEmitter;
      }
      const mockPullProcess = new EventEmitter() as MockChildProcess;
      mockPullProcess.stdout = new EventEmitter();
      mockPullProcess.stderr = new EventEmitter();
      vi.mocked(spawn).mockImplementationOnce(() => {
        setTimeout(() => {
          mockPullProcess.emit('close', 1);
        }, 1);
        return mockPullProcess as unknown as ReturnType<typeof spawn>;
      });

      const result = await SandboxOrchestrator.ensureSandboxImageIsPresent(
        'docker',
        'some-image',
      );
      expect(result).toBe(false);
    });
  });
});
