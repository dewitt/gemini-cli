/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { parse } from 'shell-quote';
import type { Config, SandboxConfig } from '../config/config.js';
import {
  coreEvents,
  debugLogger,
  LOCAL_DEV_SANDBOX_IMAGE_NAME,
} from '../index.js';

/**
 * Orchestrates sandbox image management and command construction.
 * This class contains non-UI logic for sandboxing.
 */
export class SandboxOrchestrator {
  /**
   * Constructs the arguments for the container engine 'run' command.
   */
  static getContainerRunArgs(
    config: SandboxConfig,
    containerWorkdir: string,
    sandboxFlags?: string,
  ): string[] {
    const args = ['run', '-i', '--rm', '--init', '--workdir', containerWorkdir];

    // add custom flags from settings or SANDBOX_FLAGS env var
    const flagsToUse = config.flags || sandboxFlags;
    if (flagsToUse) {
      const parsedFlags = parse(flagsToUse, process.env).filter(
        (f): f is string => typeof f === 'string',
      );
      args.push(...parsedFlags);
    }

    return args;
  }

  /**
   * Ensures the sandbox image is present locally or pulled from the registry.
   */
  static async ensureSandboxImageIsPresent(
    sandbox: string,
    image: string,
    cliConfig?: Config,
  ): Promise<boolean> {
    debugLogger.log(`Checking for sandbox image: ${image}`);
    if (await this.imageExists(sandbox, image)) {
      debugLogger.log(`Sandbox image ${image} found locally.`);
      return true;
    }

    debugLogger.log(`Sandbox image ${image} not found locally.`);
    if (image === LOCAL_DEV_SANDBOX_IMAGE_NAME) {
      // user needs to build the image themselves
      return false;
    }

    if (await this.pullImage(sandbox, image, cliConfig)) {
      // After attempting to pull, check again to be certain
      if (await this.imageExists(sandbox, image)) {
        debugLogger.log(
          `Sandbox image ${image} is now available after pulling.`,
        );
        return true;
      } else {
        debugLogger.warn(
          `Sandbox image ${image} still not found after a pull attempt. This might indicate an issue with the image name or registry, or the pull command reported success but failed to make the image available.`,
        );
        return false;
      }
    }

    coreEvents.emitFeedback(
      'error',
      `Failed to obtain sandbox image ${image} after check and pull attempt.`,
    );
    return false; // Pull command failed or image still not present
  }

  private static async imageExists(
    sandbox: string,
    image: string,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const args = ['images', '-q', image];
      const checkProcess = spawn(sandbox, args);

      let stdoutData = '';
      if (checkProcess.stdout) {
        checkProcess.stdout.on('data', (data) => {
          stdoutData += data.toString();
        });
      }

      checkProcess.on('error', (err) => {
        debugLogger.warn(
          `Failed to start '${sandbox}' command for image check: ${err.message}`,
        );
        resolve(false);
      });

      checkProcess.on('close', (_code) => {
        // Non-zero code might indicate docker daemon not running, etc.
        // The primary success indicator is non-empty stdoutData.
        resolve(stdoutData.trim() !== '');
      });
    });
  }

  private static async pullImage(
    sandbox: string,
    image: string,
    cliConfig?: Config,
  ): Promise<boolean> {
    debugLogger.debug(`Attempting to pull image ${image} using ${sandbox}...`);
    return new Promise((resolve) => {
      const args = ['pull', image];
      const pullProcess = spawn(sandbox, args, { stdio: 'pipe' });

      let _stderrData = '';

      const onStdoutData = (data: Buffer) => {
        if (cliConfig?.getDebugMode() || process.env['DEBUG']) {
          debugLogger.log(data.toString().trim()); // Show pull progress
        }
      };

      const onStderrData = (data: Buffer) => {
        _stderrData += data.toString();
        // eslint-disable-next-line no-console
        console.error(data.toString().trim()); // Show pull errors/info from the command itself
      };

      const onError = (err: Error) => {
        debugLogger.warn(
          `Failed to start '${sandbox} pull ${image}' command: ${err.message}`,
        );
        cleanup();
        resolve(false);
      };

      const onClose = (code: number | null) => {
        if (code === 0) {
          debugLogger.log(`Successfully pulled image ${image}.`);
          cleanup();
          resolve(true);
        } else {
          debugLogger.warn(
            `Failed to pull image ${image}. '${sandbox} pull ${image}' exited with code ${code}.`,
          );
          cleanup();
          resolve(false);
        }
      };

      const cleanup = () => {
        if (pullProcess.stdout) {
          pullProcess.stdout.removeListener('data', onStdoutData);
        }
        if (pullProcess.stderr) {
          pullProcess.stderr.removeListener('data', onStderrData);
        }
        pullProcess.removeListener('error', onError);
        pullProcess.removeListener('close', onClose);
      };

      if (pullProcess.stdout) {
        pullProcess.stdout.on('data', onStdoutData);
      }
      if (pullProcess.stderr) {
        pullProcess.stderr.on('data', onStderrData);
      }
      pullProcess.on('error', onError);
      pullProcess.on('close', onClose);
    });
  }
}
