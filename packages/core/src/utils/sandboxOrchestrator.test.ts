/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SandboxOrchestrator } from './sandboxOrchestrator.js';
import type { SandboxConfig } from '../config/config.js';
import { spawnAsync } from './shell-utils.js';

vi.mock('./shell-utils.js', () => ({
  spawnAsync: vi.fn(),
}));
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

    it('should handle complex quoted flags', () => {
      const config: SandboxConfig = {
        command: 'docker',
        image: 'some-image',
        flags: '--env "FOO=bar baz" --label \'key=val with spaces\'',
      };
      const args = SandboxOrchestrator.getContainerRunArgs(config, '/work');
      expect(args).toEqual([
        'run',
        '-i',
        '--rm',
        '--init',
        '--workdir',
        '/work',
        '--env',
        'FOO=bar baz',
        '--label',
        'key=val with spaces',
      ]);
    });

    it('should filter out non-string shell-quote Op objects', () => {
      const config: SandboxConfig = {
        command: 'docker',
        image: 'some-image',
        flags: '--flag > /tmp/out', // shell-quote would return { op: '>' }
      };
      const args = SandboxOrchestrator.getContainerRunArgs(config, '/work');
      expect(args).toEqual([
        'run',
        '-i',
        '--rm',
        '--init',
        '--workdir',
        '/work',
        '--flag',
        '/tmp/out',
      ]);
      // Note: shell-quote filters out the '>' op but keeps the surrounding strings
    });
  });

  describe('ensureSandboxImageIsPresent', () => {
    it('should return true if image exists locally', async () => {
      vi.mocked(spawnAsync).mockResolvedValueOnce({
        stdout: 'image-id',
        stderr: '',
      });

      const result = await SandboxOrchestrator.ensureSandboxImageIsPresent(
        'docker',
        'some-image',
      );
      expect(result).toBe(true);
      expect(spawnAsync).toHaveBeenCalledWith('docker', [
        'images',
        '-q',
        'some-image',
      ]);
    });

    it('should pull image if missing and return true on success', async () => {
      // 1. Image check fails (returns empty stdout)
      vi.mocked(spawnAsync).mockResolvedValueOnce({ stdout: '', stderr: '' });
      // 2. Pull image succeeds
      vi.mocked(spawnAsync).mockResolvedValueOnce({
        stdout: 'Successfully pulled',
        stderr: '',
      });
      // 3. Image check succeeds
      vi.mocked(spawnAsync).mockResolvedValueOnce({
        stdout: 'image-id',
        stderr: '',
      });

      const result = await SandboxOrchestrator.ensureSandboxImageIsPresent(
        'docker',
        'some-image',
      );
      expect(result).toBe(true);
      expect(spawnAsync).toHaveBeenCalledWith('docker', ['pull', 'some-image']);
    });

    it('should return false if image pull fails', async () => {
      // 1. Image check fails
      vi.mocked(spawnAsync).mockResolvedValueOnce({ stdout: '', stderr: '' });
      // 2. Pull image fails
      vi.mocked(spawnAsync).mockRejectedValueOnce(new Error('Pull failed'));

      const result = await SandboxOrchestrator.ensureSandboxImageIsPresent(
        'docker',
        'some-image',
      );
      expect(result).toBe(false);
    });
  });
});
