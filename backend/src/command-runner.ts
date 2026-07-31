import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from './errors.js';

export type AllowedExecutable = 'node' | 'npm' | 'python' | 'pytest' | 'git';

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
const relativeTestPath =
  /^(?![\\/])(?![a-zA-Z]:)(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[a-zA-Z0-9_./\\-]+$/;
const pytestOption =
  /^(?:-x|-q|-v|--quiet|--verbose|--disable-warnings|--maxfail=[1-9][0-9]{0,3}|--timeout=[1-9][0-9]{0,5}|--tb=(?:auto|long|short|line|native|no))$/;
const pytestTimeout = /^--timeout=([1-9][0-9]{0,5})$/;

function allowedPytestArguments(args: readonly string[]): boolean {
  return args.every((argument) => relativeTestPath.test(argument) || pytestOption.test(argument));
}

export function parseAllowedCommand(command: string): CommandRequest {
  const trimmed = command.trim();
  if (!trimmed || /[;&|><`$"'\\\r\n]/.test(trimmed) || trimmed.split(/\s+/).length > 51) {
    throw new AppError(
      'COMMAND_NOT_ALLOWED',
      'Verification command is not allowed by policy',
      { command },
      403
    );
  }
  const [executable, ...args] = trimmed.split(/\s+/);
  if (!['node', 'npm', 'python', 'pytest', 'git'].includes(executable)) {
    throw new AppError(
      'COMMAND_NOT_ALLOWED',
      'Verification command is not allowed by policy',
      { command },
      403
    );
  }
  const request = { executable: executable as AllowedExecutable, args };
  assertCommandAllowed(request);
  return request;
}

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
      ((command === '--version' || command === '-v') && target === undefined) ||
      (command === '--test' &&
        (target === undefined ||
          (relativeTestPath.test(target) &&
            rest.every((argument) => relativeTestPath.test(argument))))) ||
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
      ((command === 'install' || command === 'ci') && script === undefined && rest.length === 0) ||
      (command === 'run' &&
        typeof script === 'string' &&
        npmScriptName.test(script) &&
        rest.length === 0);
    if (allowed) return;
  }

  if (request.executable === 'python') {
    const [command, target, ...rest] = request.args;
    const allowed =
      ((command === '--version' || command === '-V') && target === undefined) ||
      (command === '-m' && target === 'pytest' && allowedPytestArguments(rest));
    if (allowed) return;
  }

  if (request.executable === 'pytest' && allowedPytestArguments(request.args)) return;

  if (request.executable === 'git') {
    const [command, ...args] = request.args;
    const allowedByCommand: Record<string, readonly string[]> = {
      status: ['--short', '--porcelain', '--porcelain=v1', '--branch', '--untracked-files=all'],
      diff: ['--stat', '--name-only', '--name-status', '--cached', '--check'],
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
    signal?: AbortSignal,
    projectSourcePath?: string
  ): Promise<CommandOutput> {
    assertCommandAllowed(request);
    if (signal?.aborted) throw this.abortReason(signal);
    const timeoutMs = request.timeoutMs ?? this.pytestTimeoutMs(request) ?? this.maxTimeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > this.maxTimeoutMs) {
      throw new AppError('VALIDATION_ERROR', 'Command timeout is outside the allowed range', {
        timeoutMs,
        maxTimeoutMs: this.maxTimeoutMs
      });
    }

    return new Promise((resolve, reject) => {
      let executable: string = request.executable;
      let spawnArgs = request.args;
      if (request.executable === 'python' || request.executable === 'pytest') {
        const pythonExecutable = this.findPythonExecutable(workspace, projectSourcePath);
        const pytestArgs = request.args.filter((argument) => !pytestTimeout.test(argument));
        if (pythonExecutable) {
          executable = pythonExecutable;
          spawnArgs =
            request.executable === 'pytest'
              ? ['-m', 'pytest', ...pytestArgs]
              : request.args[0] === '-m' && request.args[1] === 'pytest'
                ? ['-m', 'pytest', ...pytestArgs.slice(2)]
                : request.args;
        }
      }
      if (request.executable === 'node') executable = process.execPath;
      if (process.platform === 'win32' && request.executable === 'npm') {
        const npmCli = this.findNpmCli();
        if (!npmCli) {
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
      const temporaryDirectory = path.join(path.dirname(workspace), 'artifacts');
      fs.mkdirSync(temporaryDirectory, { recursive: true });
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(executable, spawnArgs, {
          cwd: workspace,
          env: this.commandEnvironment(temporaryDirectory, request),
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

  private findPythonExecutable(workspace: string, projectSourcePath?: string): string | undefined {
    if (process.platform !== 'win32') return undefined;
    const roots = [projectSourcePath, workspace].filter((root): root is string => Boolean(root));
    for (const root of roots) {
      for (const environmentName of ['.venv', 'venv']) {
        const candidate = path.join(root, environmentName, 'Scripts', 'python.exe');
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    return undefined;
  }

  private pytestTimeoutMs(request: CommandRequest): number | undefined {
    if (request.executable !== 'python' && request.executable !== 'pytest') return undefined;
    const seconds = request.args
      .find((argument) => pytestTimeout.test(argument))
      ?.match(pytestTimeout)?.[1];
    if (!seconds) return undefined;
    return Math.min(Number(seconds) * 1_000, this.maxTimeoutMs);
  }

  private commandEnvironment(
    temporaryDirectory?: string,
    request?: CommandRequest
  ): NodeJS.ProcessEnv {
    const isDependencyBootstrap =
      request?.executable === 'npm' && ['install', 'ci'].includes(request.args[0] ?? '');
    const environment: NodeJS.ProcessEnv = {
      CI: 'true',
      GIT_TERMINAL_PROMPT: '0',
      PATH: [path.dirname(process.execPath), process.env.PATH ?? process.env.Path]
        .filter((entry): entry is string => Boolean(entry))
        .join(path.delimiter),
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
      ...(isDependencyBootstrap ? { npm_config_ignore_scripts: 'true' } : {})
    };
    const allowed = [
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
    if (temporaryDirectory) {
      environment.TEMP = temporaryDirectory;
      environment.TMP = temporaryDirectory;
    }
    return environment;
  }

  private abortReason(signal: AbortSignal): unknown {
    return (
      signal.reason ??
      new AppError('TASK_CANCELLED', 'Command execution was cancelled', undefined, 409)
    );
  }

  private findNpmCli(): string | undefined {
    const candidates = [
      process.env.npm_execpath,
      path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    ];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || !/npm-cli\.js$/i.test(candidate)) continue;
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Try the next trusted runtime location.
      }
    }
    return undefined;
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
