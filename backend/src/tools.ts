import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AppError } from './errors.js';
import { config } from './config.js';
import type { WorkspaceManager } from './workspace.js';

const allowedCommands = new Set(['npm', 'node', 'git']);

function parseCommand(command: string): string[] {
  const args =
    command.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((arg) => arg.replace(/^"|"$/g, '')) ?? [];
  if (args.length === 0 || !allowedCommands.has(args[0])) {
    throw new AppError('COMMAND_NOT_ALLOWED', 'Command is not on the allowlist', { command }, 403);
  }
  if (/[;&|><`$]/.test(command)) {
    throw new AppError('COMMAND_NOT_ALLOWED', 'Shell operators are not allowed', { command }, 403);
  }
  return args;
}

export class ToolExecutor {
  constructor(private readonly workspaceManager: WorkspaceManager) {}

  async listFiles(workspace: string, requestedPath = '.'): Promise<string[]> {
    const directory = await this.workspaceManager.resolve(workspace, requestedPath);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => path.join(requestedPath, entry.name));
  }

  async readFile(workspace: string, requestedPath: string): Promise<string> {
    const file = await this.workspaceManager.resolve(workspace, requestedPath);
    return fs.readFile(file, 'utf8');
  }

  async searchText(
    workspace: string,
    query: string
  ): Promise<Array<{ path: string; line: number; text: string }>> {
    const results: Array<{ path: string; line: number; text: string }> = [];
    const walk = async (relativeDirectory: string): Promise<void> => {
      const directory = await this.workspaceManager.resolve(workspace, relativeDirectory);
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink())
          continue;
        const relative = path.join(relativeDirectory, entry.name);
        const absolute = await this.workspaceManager.resolve(workspace, relative);
        if (entry.isDirectory()) await walk(relative);
        else {
          const content = await fs.readFile(absolute, 'utf8').catch(() => undefined);
          if (!content) continue;
          content.split(/\r?\n/).forEach((text, index) => {
            if (text.includes(query))
              results.push({ path: path.relative(workspace, absolute), line: index + 1, text });
          });
        }
      }
    };
    await walk('.');
    return results.slice(0, 200);
  }

  async applyPatch(workspace: string, requestedPath: string, content: string): Promise<void> {
    const file = await this.workspaceManager.resolve(workspace, requestedPath, 'write');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, 'utf8');
  }

  async gitStatus(workspace: string): Promise<Awaited<ReturnType<WorkspaceManager['getStatus']>>> {
    return this.workspaceManager.getStatus(workspace);
  }

  async gitDiff(workspace: string): Promise<string> {
    return this.workspaceManager.getDiff(workspace);
  }

  async runCommand(
    workspace: string,
    command: string
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const [executable, ...args] = parseCommand(command);
    const managedWorkspace = await this.workspaceManager.resolve(workspace, '.');
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: managedWorkspace,
        shell: false,
        windowsHide: true
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      const timer = setTimeout(() => {
        child.kill();
        reject(new AppError('WORKSPACE_ERROR', 'Command timed out', { command }, 408));
      }, config.maxCommandTimeoutMs);
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  }
}
