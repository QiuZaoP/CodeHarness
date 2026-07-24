import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { AppError } from './errors.js';

export type AllowedExecutable = 'node' | 'npm' | 'git';

export interface CommandRequest {
  executable: AllowedExecutable;
  args: string[];
  timeoutMs?: number;
}

export interface CommandOutput {
  code: number;
  signal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
}

const forbiddenArgumentCharacters = /[;&|><`\r\n\0]/;
const npmScriptName = /^[a-zA-Z0-9:_-]+$/;
const relativeJavaScriptPath = /^(?![\\/])(?![a-zA-Z]:)[a-zA-Z0-9_./\\-]+\.[cm]?js$/;

export function assertCommandAllowed(request: CommandRequest): void {
  if (
    request.args.some(
      (argument) =>
        typeof argument !== 'string' ||
        argument.length > 1_000 ||
        forbiddenArgumentCharacters.test(argument)
    )
  ) {
    throw new AppError(
      'COMMAND_NOT_ALLOWED',
      'Command arguments contain forbidden characters',
      undefined,
      403
    );
  }

  if (request.executable === 'node') {
    const [command, target, ...rest] = request.args;
    const allowed =
      ((command === '--version' || command === '-v' || command === '--test') &&
        target === undefined) ||
      (command === '--check' &&
        typeof target === 'string' &&
        relativeJavaScriptPath.test(target) &&
        rest.length === 0);
    if (allowed) return;
  }

  if (request.executable === 'npm') {
    const [command, script, ...rest] = request.args;
    const allowed =
      (command === '--version' && script === undefined) ||
      (command === 'test' && script === undefined) ||
      (command === 'run' &&
        typeof script === 'string' &&
        npmScriptName.test(script) &&
        rest.length === 0);
    if (allowed) return;
  }

  if (request.executable === 'git') {
    const [command, ...args] = request.args;
    const allowedByCommand: Record<string, readonly string[]> = {
      status: ['--short', '--porcelain', '--porcelain=v1', '--branch', '--untracked-files=all'],
      diff: ['--stat', '--name-only', '--name-status', '--cached'],
      log: ['--oneline', '--decorate', '--all', 'HEAD'],
      show: ['--stat', '--oneline', 'HEAD'],
      'rev-parse': ['HEAD', '--show-toplevel', '--abbrev-ref']
    };
    const allowedArguments = command ? allowedByCommand[command] : undefined;
    if (
      allowedArguments &&
      args.length <= 5 &&
      args.every(
        (argument) =>
          allowedArguments.includes(argument) || /^--max-count=[1-9][0-9]{0,2}$/.test(argument)
      )
    ) {
      return;
    }
  }

  throw new AppError(
    'COMMAND_NOT_ALLOWED',
    'Executable or subcommand is not allowed by policy',
    { executable: request.executable, args: request.args },
    403
  );
}

export class ControlledCommandRunner {
  constructor(
    private readonly maxTimeoutMs: number,
    private readonly maxOutputBytes: number
  ) {}

  async run(
    workspace: string,
    request: CommandRequest,
    signal?: AbortSignal
  ): Promise<CommandOutput> {
    assertCommandAllowed(request);
    if (signal?.aborted) throw this.abortReason(signal);
    const timeoutMs = request.timeoutMs ?? this.maxTimeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > this.maxTimeoutMs) {
      throw new AppError('VALIDATION_ERROR', 'Command timeout is outside the allowed range', {
        timeoutMs,
        maxTimeoutMs: this.maxTimeoutMs
      });
    }

    return new Promise((resolve, reject) => {
      let executable: string = request.executable;
      let spawnArgs = request.args;
      if (process.platform === 'win32' && request.executable === 'npm') {
        const npmCli = process.env.npm_execpath;
        if (!npmCli || !/npm-cli\.js$/i.test(npmCli)) {
          reject(
            new AppError(
              'WORKSPACE_ERROR',
              'npm CLI path is unavailable',
              { category: 'ENVIRONMENT' },
              500
            )
          );
          return;
        }
        executable = process.execPath;
        spawnArgs = [npmCli, ...request.args];
      }
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(executable, spawnArgs, {
          cwd: workspace,
          env: this.commandEnvironment(),
          shell: false,
          windowsHide: true,
          detached: process.platform !== 'win32'
        });
      } catch (error) {
        reject(this.environmentError(request, error));
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutStored = 0;
      let stderrStored = 0;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let truncated = false;
      let settled = false;

      const append = (target: Buffer[], chunk: Buffer, stored: number): number => {
        const remaining = Math.max(0, this.maxOutputBytes - stdoutStored - stderrStored);
        if (chunk.length > remaining) truncated = true;
        if (remaining > 0) {
          target.push(chunk.subarray(0, remaining));
          return stored + Math.min(chunk.length, remaining);
        }
        return stored;
      };

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        stdoutStored = append(stdout, chunk, stdoutStored);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        stderrStored = append(stderr, chunk, stderrStored);
      });

      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const fail = async (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        await this.terminateProcessTree(child);
        reject(error);
      };
      const onAbort = () => void fail(signal ? this.abortReason(signal) : undefined);
      const timer = setTimeout(
        () =>
          void fail(
            new AppError(
              'WORKSPACE_ERROR',
              'Command timed out',
              { category: 'TIMEOUT', timeoutMs },
              408
            )
          ),
        timeoutMs
      );
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();

      child.on('error', (error) => void fail(this.environmentError(request, error)));
      child.on('close', (code, closeSignal) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          code: code ?? 1,
          signal: closeSignal ?? undefined,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          stdoutBytes,
          stderrBytes,
          truncated
        });
      });
    });
  }

  private commandEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
      CI: 'true',
      GIT_TERMINAL_PROMPT: '0',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false'
    };
    const allowed = [
      'PATH',
      'Path',
      'PATHEXT',
      'SystemRoot',
      'ComSpec',
      'TEMP',
      'TMP',
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'NODE_ENV'
    ];
    for (const name of allowed) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }

  private abortReason(signal: AbortSignal): unknown {
    return (
      signal.reason ??
      new AppError('TASK_CANCELLED', 'Command execution was cancelled', undefined, 409)
    );
  }

  private environmentError(request: CommandRequest, error: unknown): AppError {
    return new AppError(
      'WORKSPACE_ERROR',
      'Command could not be started',
      {
        category: 'ENVIRONMENT',
        executable: request.executable,
        cause: error instanceof Error ? error.message : String(error)
      },
      500
    );
  }

  private async terminateProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
    const pid = child.pid;
    if (!pid) return;
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore'
        });
        killer.once('error', () => resolve());
        killer.once('close', () => resolve());
      });
      await this.waitForProcessClose(child);
      return;
    }
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    await this.waitForProcessClose(child, 250);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
    await this.waitForProcessClose(child);
  }

  private async waitForProcessClose(
    child: ChildProcessWithoutNullStreams,
    timeoutMs = 1_000
  ): Promise<void> {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const onClose = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          child.removeListener('close', onClose);
          resolve();
        }, timeoutMs);
        child.once('close', onClose);
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
