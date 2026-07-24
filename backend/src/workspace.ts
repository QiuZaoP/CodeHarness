import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.js';
import { config } from './config.js';

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export class WorkspaceManager {
  async create(sourcePath: string, projectId: string): Promise<string> {
    const source = path.resolve(sourcePath);
    const stat = await fs.stat(source).catch(() => undefined);
    if (!stat?.isDirectory()) {
      throw new AppError('VALIDATION_ERROR', 'sourcePath must be an existing directory', {
        sourcePath
      });
    }

    const workspace = path.resolve(config.workspaceRoot, projectId, 'current');
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.cp(source, workspace, {
      recursive: true,
      filter: (entry) => !['.git', 'node_modules', '.data'].includes(path.basename(entry))
    });
    await this.snapshot(projectId, workspace, 'baseline');
    return workspace;
  }

  async snapshot(projectId: string, workspace: string, name: string): Promise<string> {
    const destination = path.resolve(config.workspaceRoot, projectId, 'snapshots', name);
    const projectRoot = path.resolve(config.workspaceRoot, projectId);
    if (!isWithin(projectRoot, destination)) {
      throw new AppError('WORKSPACE_ERROR', 'Snapshot path escaped project workspace');
    }
    await fs.rm(destination, { recursive: true, force: true });
    await fs.cp(workspace, destination, { recursive: true });
    return destination;
  }

  resolve(workspace: string, requestedPath: string): string {
    const resolved = path.resolve(workspace, requestedPath);
    if (!isWithin(path.resolve(workspace), resolved)) {
      throw new AppError('FORBIDDEN', 'Path is outside the task workspace', { requestedPath }, 403);
    }
    return resolved;
  }

  async rollback(projectId: string, workspace: string): Promise<void> {
    const baseline = path.resolve(config.workspaceRoot, projectId, 'snapshots', 'baseline');
    const exists = await fs.stat(baseline).catch(() => undefined);
    if (!exists) throw new AppError('WORKSPACE_ERROR', 'Baseline snapshot does not exist');
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.cp(baseline, workspace, { recursive: true });
  }
}
