import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { config } from './config.js';
import { AppError } from './errors.js';
import type { SourceGitMetadata, SourceMetadata, WorkspaceSnapshot } from './types.js';
import type { FileChange, FileChangeStatus } from './types.js';

const ignoredSourceEntries = new Set([
  '.git',
  '.data',
  '.next',
  '.pytest_cache',
  '.pytest_run',
  '.pytest_run_all',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
  'venv'
]);

// Generated local databases are not source files and can be large or locked while the app runs.
const ignoredSourceFileExtensions = new Set(['.db', '.sqlite', '.sqlite3']);

function isSensitiveSourceEntry(name: string): boolean {
  return (
    name === '.env' || name.startsWith('.env.') || name.endsWith('.pem') || name.endsWith('.key')
  );
}

function isExcludedSourceEntry(name: string): boolean {
  return (
    ignoredSourceEntries.has(name) || name.startsWith('.pytest_') || isSensitiveSourceEntry(name)
  );
}

function isExcludedSourcePath(filePath: string): boolean {
  const parts = normalizedRelative(filePath).split('/').filter(Boolean);
  return (
    parts.some((part) => isExcludedSourceEntry(part)) ||
    ignoredSourceFileExtensions.has(path.posix.extname(filePath).toLowerCase())
  );
}

interface ManifestEntry {
  kind: 'file' | 'directory';
  path: string;
  size: number;
  mode: number;
  sha256: string;
  binary: boolean;
}

interface SourceCapture {
  metadata: SourceMetadata;
  manifest: ManifestEntry[];
}

export interface WorkspaceOptions {
  root: string;
  maxImportFiles: number;
  maxImportBytes: number;
  maxFileBytes: number;
  retentionHours: number;
}

export interface ImportedProject {
  sourcePath: string;
  projectPath: string;
  metadata: SourceMetadata;
}

export interface CreatedTaskWorkspace {
  workspacePath: string;
  baseline: WorkspaceSnapshot;
}

export interface WorkspaceStatus {
  clean: boolean;
  entries: string[];
}

export interface WorkspaceTextFile {
  path: string;
  content: string;
  bytesRead: number;
  truncated: boolean;
}

export interface ImportedProjectFileList {
  files: string[];
}

export interface WorkspaceDiffFile {
  path: string;
  status: Exclude<FileChangeStatus, 'RENAMED'>;
  additions: number;
  deletions: number;
  patch: string;
}

const defaultOptions: WorkspaceOptions = {
  root: config.workspaceRoot,
  maxImportFiles: config.maxImportFiles,
  maxImportBytes: config.maxImportBytes,
  maxFileBytes: config.maxFileBytes,
  retentionHours: config.workspaceRetentionHours
};

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizedRelative(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function manifestHash(entries: ManifestEntry[]): string {
  return hash(
    entries
      .map(
        (entry) =>
          `${entry.kind}\0${entry.path}\0${entry.size}\0${entry.mode}\0${entry.sha256}\0${entry.binary ? 1 : 0}`
      )
      .join('\n')
  );
}

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8_000).includes(0);
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[a-zA-Z0-9-]+$/.test(value)) {
    throw new AppError('VALIDATION_ERROR', `${label} contains unsupported characters`, {
      [label]: value
    });
  }
}

export class WorkspaceManager {
  private readonly options: WorkspaceOptions;
  private readonly root: string;

  constructor(options: Partial<WorkspaceOptions> = {}) {
    this.options = { ...defaultOptions, ...options };
    this.root = path.resolve(this.options.root);
  }

  async importProject(sourcePath: string, projectId: string): Promise<ImportedProject> {
    assertIdentifier(projectId, 'projectId');
    const source = await this.requireSourceDirectory(sourcePath);
    await this.assertNonRecursiveSource(source);
    const projectPath = this.projectPath(projectId);
    await fs.mkdir(path.dirname(projectPath), { recursive: true });
    let created = false;
    try {
      await fs.mkdir(projectPath);
      created = true;
      const metadataPath = path.join(projectPath, 'source-metadata');
      await fs.mkdir(metadataPath);
      const capture = await this.captureSource(source);
      await fs.writeFile(
        path.join(metadataPath, 'manifest.json'),
        `${JSON.stringify(capture.manifest, null, 2)}\n`,
        'utf8'
      );
      await fs.writeFile(
        path.join(metadataPath, 'source.json'),
        `${JSON.stringify(capture.metadata, null, 2)}\n`,
        'utf8'
      );
      return { sourcePath: source, projectPath, metadata: capture.metadata };
    } catch (error) {
      if (created) await this.removeValidated(projectPath, this.root);
      throw error;
    }
  }

  async createTaskWorkspace(
    projectId: string,
    taskId: string,
    sourcePath: string
  ): Promise<CreatedTaskWorkspace> {
    assertIdentifier(projectId, 'projectId');
    assertIdentifier(taskId, 'taskId');
    const source = await this.requireSourceDirectory(sourcePath);
    await this.assertNonRecursiveSource(source);
    const taskPath = this.taskPath(taskId);
    const workspacePath = path.join(taskPath, 'worktree');
    await fs.mkdir(path.dirname(taskPath), { recursive: true });
    let created = false;
    try {
      await fs.mkdir(taskPath);
      created = true;
      await fs.mkdir(workspacePath);
      await fs.mkdir(path.join(taskPath, 'artifacts'));
      const capture = await this.captureSource(source, workspacePath);
      const baseline = await this.createSnapshot(
        taskId,
        workspacePath,
        'BASELINE',
        capture.metadata.git.revision
      );
      await this.initializeIsolatedGit(workspacePath, taskPath);
      return { workspacePath, baseline };
    } catch (error) {
      if (created) await this.removeValidated(taskPath, this.root);
      throw error;
    }
  }

  async removeProject(projectId: string): Promise<void> {
    assertIdentifier(projectId, 'projectId');
    await this.removeValidated(this.projectPath(projectId), path.join(this.root, 'projects'));
  }

  async removeTask(taskId: string): Promise<void> {
    assertIdentifier(taskId, 'taskId');
    await this.removeValidated(this.taskPath(taskId), path.join(this.root, 'tasks'));
  }

  async removeSnapshot(taskId: string, snapshotId: string): Promise<void> {
    assertIdentifier(taskId, 'taskId');
    assertIdentifier(snapshotId, 'snapshotId');
    const snapshotsPath = path.join(this.taskPath(taskId), 'snapshots');
    await this.removeValidated(path.join(snapshotsPath, snapshotId), snapshotsPath);
  }

  async listImportedFiles(projectId: string): Promise<ImportedProjectFileList> {
    assertIdentifier(projectId, 'projectId');
    const projectPath = this.projectPath(projectId);
    const manifestPath = path.join(projectPath, 'source-metadata', 'manifest.json');
    const rawManifest = await fs
      .readFile(manifestPath, 'utf8')
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          throw new AppError(
            'NOT_FOUND',
            'Imported project metadata does not exist',
            { projectId },
            404
          );
        }
        throw error;
      });
    let manifest: unknown;
    try {
      manifest = JSON.parse(rawManifest);
    } catch {
      throw new AppError('WORKSPACE_ERROR', 'Imported project manifest is invalid', { projectId });
    }
    if (!Array.isArray(manifest)) {
      throw new AppError('WORKSPACE_ERROR', 'Imported project manifest is invalid', { projectId });
    }
    const files = manifest
      .filter(
        (entry): entry is ManifestEntry =>
          typeof entry === 'object' &&
          entry !== null &&
          (entry as { kind?: unknown }).kind === 'file' &&
          typeof (entry as { path?: unknown }).path === 'string'
      )
      .map((entry) => entry.path)
      .filter((entry) => entry.length > 0 && !entry.includes('..') && !isExcludedSourcePath(entry))
      .sort((left, right) => left.localeCompare(right));
    return { files };
  }

  async readImportedSourceFile(
    sourcePath: string,
    requestedPath: string
  ): Promise<WorkspaceTextFile> {
    if (
      !requestedPath ||
      requestedPath.includes('\0') ||
      path.isAbsolute(requestedPath) ||
      path.win32.isAbsolute(requestedPath)
    ) {
      throw new AppError(
        'FORBIDDEN',
        'Only relative paths inside the imported project are allowed',
        {
          requestedPath
        },
        403
      );
    }
    const source = await this.requireSourceDirectory(sourcePath);
    if (isExcludedSourcePath(requestedPath)) {
      throw new AppError(
        'FORBIDDEN',
        'Excluded source files cannot be displayed',
        { requestedPath },
        403
      );
    }
    const candidate = path.resolve(source, requestedPath);
    if (!isWithin(source, candidate)) {
      throw new AppError(
        'FORBIDDEN',
        'Path is outside the imported project',
        { requestedPath },
        403
      );
    }
    const relative = path.relative(source, candidate);
    let cursor = source;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      const stat = await fs.lstat(cursor).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!stat) {
        throw new AppError('NOT_FOUND', 'Source file does not exist', { requestedPath }, 404);
      }
      if (stat.isSymbolicLink()) {
        throw new AppError(
          'FORBIDDEN',
          'Symbolic links are not allowed in imported project paths',
          {
            requestedPath
          },
          403
        );
      }
    }
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) {
      throw new AppError('WORKSPACE_ERROR', 'Requested source path is not a file', {
        requestedPath
      });
    }
    if (stat.size > config.maxReadFileBytes) {
      throw new AppError('WORKSPACE_ERROR', 'Source file exceeds the read size limit', {
        category: 'FILE_TOO_LARGE',
        requestedPath,
        size: stat.size,
        maxReadFileBytes: config.maxReadFileBytes
      });
    }
    const content = await fs.readFile(candidate);
    if (isBinary(content)) {
      throw new AppError('WORKSPACE_ERROR', 'Binary files cannot be displayed as text', {
        category: 'BINARY_FILE',
        requestedPath
      });
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      throw new AppError('WORKSPACE_ERROR', 'Source file is not valid UTF-8 text', {
        category: 'BINARY_FILE',
        requestedPath
      });
    }
    return {
      path: normalizedRelative(requestedPath),
      content: text,
      bytesRead: content.length,
      truncated: false
    };
  }

  async resolve(
    workspace: string,
    requestedPath: string,
    intent: 'read' | 'write' = 'read'
  ): Promise<string> {
    if (
      requestedPath.includes('\0') ||
      path.isAbsolute(requestedPath) ||
      path.win32.isAbsolute(requestedPath)
    ) {
      throw new AppError(
        'FORBIDDEN',
        'Only relative paths inside the task workspace are allowed',
        { requestedPath },
        403
      );
    }
    const workspaceRoot = await this.requireManagedWorkspace(workspace);
    const candidate = path.resolve(workspaceRoot, requestedPath);
    if (!isWithin(workspaceRoot, candidate)) {
      throw new AppError('FORBIDDEN', 'Path is outside the task workspace', { requestedPath }, 403);
    }

    const relative = path.relative(workspaceRoot, candidate);
    let cursor = workspaceRoot;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      const stat = await fs.lstat(cursor).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!stat) {
        if (intent === 'read') {
          throw new AppError('WORKSPACE_ERROR', 'Workspace path does not exist', {
            requestedPath
          });
        }
        break;
      }
      if (stat.isSymbolicLink()) {
        throw new AppError(
          'FORBIDDEN',
          'Symbolic links are not allowed in task workspace paths',
          { requestedPath },
          403
        );
      }
      if (!stat.isDirectory() && !stat.isFile()) {
        throw new AppError('FORBIDDEN', 'Special files are not allowed in task workspaces', {
          requestedPath
        });
      }
    }

    const nearest = await this.nearestExistingPath(candidate);
    const canonicalNearest = await fs.realpath(nearest);
    if (!isWithin(workspaceRoot, canonicalNearest)) {
      throw new AppError('FORBIDDEN', 'Path resolves outside the task workspace', {
        requestedPath
      });
    }
    return candidate;
  }

  async getStatus(workspace: string): Promise<WorkspaceStatus> {
    const root = await this.requireManagedWorkspace(workspace);
    const output = await this.runGit(root, ['status', '--porcelain=v1', '--untracked-files=all']);
    const entries = output
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean);
    return { clean: entries.length === 0, entries };
  }

  async assertReady(workspace: string): Promise<void> {
    const root = await this.requireManagedWorkspace(workspace);
    await fs.access(root, fsConstants.R_OK | fsConstants.W_OK);
    const gitDirectory = await fs.lstat(path.join(root, '.git')).catch(() => undefined);
    if (!gitDirectory?.isDirectory()) {
      throw new AppError('WORKSPACE_ERROR', 'Task workspace is not an isolated Git repository');
    }
  }

  async readOptionalTextFile(
    workspace: string,
    requestedPath: string,
    maxBytes: number,
    signal: AbortSignal
  ): Promise<WorkspaceTextFile | undefined> {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new AppError('VALIDATION_ERROR', 'Text file byte limit must be a positive integer');
    }
    signal.throwIfAborted();
    const absolute = await this.resolve(workspace, requestedPath, 'write');
    const stat = await fs.lstat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!stat) return undefined;
    if (!stat.isFile()) return undefined;
    const handle = await fs.open(absolute, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, maxBytes + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      signal.throwIfAborted();
      const value = buffer.subarray(0, Math.min(bytesRead, maxBytes));
      if (value.subarray(0, 8_000).includes(0)) return undefined;
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(value);
      } catch {
        return undefined;
      }
      return {
        path: requestedPath.replaceAll('\\', '/'),
        content,
        bytesRead,
        truncated: stat.size > maxBytes
      };
    } finally {
      await handle.close();
    }
  }

  async getDiff(workspace: string): Promise<string> {
    const root = await this.requireManagedWorkspace(workspace);
    return this.withTemporaryIndex(root, (indexPath) =>
      this.runGit(
        root,
        ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD'],
        indexPath
      )
    );
  }

  async getStructuredDiff(workspace: string): Promise<WorkspaceDiffFile[]> {
    const root = await this.requireManagedWorkspace(workspace);
    return this.withTemporaryIndex(root, async (indexPath) => {
      const raw = await this.runGit(
        root,
        ['diff', '--cached', '--name-status', '-z', '--no-renames', 'HEAD'],
        indexPath
      );
      const fields = raw.split('\0').filter((value) => value.length > 0);
      const files: WorkspaceDiffFile[] = [];
      for (let index = 0; index < fields.length; index += 2) {
        const code = fields[index]!;
        const filePath = fields[index + 1];
        if (!filePath || !['A', 'M', 'D'].includes(code)) {
          throw new AppError('WORKSPACE_ERROR', 'Git returned an unsupported Diff status', {
            code,
            filePath
          });
        }
        const patch = await this.runGit(
          root,
          [
            'diff',
            '--cached',
            '--binary',
            '--no-ext-diff',
            '--no-textconv',
            'HEAD',
            '--',
            filePath
          ],
          indexPath
        );
        const lines = patch.split(/\r?\n/);
        files.push({
          path: filePath.replaceAll('\\', '/'),
          status: ({ A: 'ADDED', M: 'MODIFIED', D: 'DELETED' } as const)[code as 'A' | 'M' | 'D'],
          additions: lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
          deletions: lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
          patch
        });
      }
      return files;
    });
  }

  async applyAcceptedChanges<T>(
    taskId: string,
    workspace: string,
    sourcePath: string,
    baseline: WorkspaceSnapshot,
    changes: readonly FileChange[],
    commit: () => T | Promise<T>
  ): Promise<T> {
    assertIdentifier(taskId, 'taskId');
    const taskPath = this.taskPath(taskId);
    const expectedWorkspace = path.join(taskPath, 'worktree');
    if (path.resolve(workspace) !== expectedWorkspace) {
      throw new AppError('WORKSPACE_ERROR', 'Task workspace path does not match its task', {
        taskId
      });
    }
    await this.requireManagedWorkspace(workspace);
    const source = await this.requireSourceDirectory(sourcePath);
    await fs.access(source, fsConstants.R_OK | fsConstants.W_OK);
    const baselinePath = await this.requireBaseline(taskPath, baseline);
    const baselineTree = path.join(baselinePath, 'tree');
    await this.verifySnapshot(baselineTree, baseline.rootHash);
    const accepted = changes.filter(({ decision }) => decision === 'ACCEPTED');
    const backupRoot = path.join(taskPath, `apply-backup-${randomUUID()}`);
    const prepared: Array<{
      change: FileChange;
      target: string;
      workspaceFile: string;
      existed: boolean;
    }> = [];
    await fs.mkdir(backupRoot);
    try {
      for (const change of accepted) {
        if (change.status === 'RENAMED') {
          throw new AppError('WORKSPACE_ERROR', 'Renamed changes require explicit source paths');
        }
        const target = await this.resolveTreePath(source, change.path, true);
        const baselineFile = await this.resolveTreePath(baselineTree, change.path, true);
        const workspaceFile = await this.resolveTreePath(workspace, change.path, true);
        const targetStat = await fs.lstat(target).catch(() => undefined);
        const baselineStat = await fs.lstat(baselineFile).catch(() => undefined);
        const workspaceStat = await fs.lstat(workspaceFile).catch(() => undefined);
        if (targetStat?.isSymbolicLink() || baselineStat?.isSymbolicLink()) {
          throw new AppError('FORBIDDEN', 'Source changes cannot traverse symbolic links', {
            path: change.path
          });
        }
        if (change.status === 'ADDED') {
          if (targetStat || baselineStat || !workspaceStat?.isFile()) {
            throw new AppError('CONFLICT', 'Added file no longer has a safe source baseline', {
              path: change.path
            });
          }
        } else if (change.status === 'MODIFIED') {
          if (
            !targetStat?.isFile() ||
            !baselineStat?.isFile() ||
            !workspaceStat?.isFile() ||
            hash(await fs.readFile(target)) !== hash(await fs.readFile(baselineFile))
          ) {
            throw new AppError('CONFLICT', 'Source file changed after task creation', {
              path: change.path
            });
          }
        } else if (
          !targetStat?.isFile() ||
          !baselineStat?.isFile() ||
          workspaceStat ||
          hash(await fs.readFile(target)) !== hash(await fs.readFile(baselineFile))
        ) {
          throw new AppError('CONFLICT', 'Deleted source file changed after task creation', {
            path: change.path
          });
        }
        if (targetStat) {
          const backup = path.join(backupRoot, change.path);
          await fs.mkdir(path.dirname(backup), { recursive: true });
          await fs.copyFile(target, backup);
          await fs.chmod(backup, targetStat.mode & 0o777);
        }
        prepared.push({ change, target, workspaceFile, existed: Boolean(targetStat) });
      }

      let applied = 0;
      try {
        for (const item of prepared) {
          if (item.change.status === 'DELETED') {
            await fs.rm(item.target);
          } else {
            await this.atomicCopyFile(item.workspaceFile, item.target);
          }
          applied += 1;
        }
        return await commit();
      } catch (error) {
        for (const item of prepared.slice(0, applied).reverse()) {
          if (item.existed) {
            await this.atomicCopyFile(path.join(backupRoot, item.change.path), item.target);
          } else {
            await fs.rm(item.target, { force: true });
          }
        }
        throw error;
      }
    } finally {
      await this.removeValidated(backupRoot, taskPath).catch(() => undefined);
    }
  }

  private async withTemporaryIndex<T>(
    root: string,
    operation: (indexPath: string) => Promise<T>
  ): Promise<T> {
    const indexPath = path.join(root, '.git', `codeharness-index-${randomUUID()}`);
    const normalIndex = path.join(root, '.git', 'index');
    await fs.copyFile(normalIndex, indexPath);
    try {
      await this.runGit(root, ['add', '-A'], indexPath);
      return await operation(indexPath);
    } finally {
      await fs.rm(indexPath, { force: true });
      await fs.rm(`${indexPath}.lock`, { force: true });
    }
  }

  async createCheckpoint(
    taskId: string,
    workspace: string,
    kind: Exclude<WorkspaceSnapshot['kind'], 'BASELINE'> = 'CHECKPOINT'
  ): Promise<WorkspaceSnapshot> {
    assertIdentifier(taskId, 'taskId');
    const expectedWorkspace = path.join(this.taskPath(taskId), 'worktree');
    if (path.resolve(workspace) !== expectedWorkspace) {
      throw new AppError('WORKSPACE_ERROR', 'Task workspace path does not match its task', {
        taskId
      });
    }
    const managedWorkspace = await this.requireManagedWorkspace(workspace);
    return this.createSnapshot(taskId, managedWorkspace, kind);
  }

  async rollback(taskId: string, workspace: string, baseline: WorkspaceSnapshot): Promise<void> {
    assertIdentifier(taskId, 'taskId');
    const taskPath = this.taskPath(taskId);
    const expectedWorkspace = path.join(taskPath, 'worktree');
    if (path.resolve(workspace) !== expectedWorkspace) {
      throw new AppError('WORKSPACE_ERROR', 'Task workspace path does not match its task', {
        taskId
      });
    }
    await this.requireManagedWorkspace(expectedWorkspace);
    const baselinePath = await this.requireBaseline(taskPath, baseline);
    const snapshotTree = path.join(baselinePath, 'tree');
    await this.verifySnapshot(snapshotTree, baseline.rootHash);

    const recovery = path.join(taskPath, `recovery-${randomUUID()}`);
    const backup = path.join(taskPath, `backup-${randomUUID()}`);
    try {
      await fs.cp(snapshotTree, recovery, { recursive: true, errorOnExist: true, force: false });
      await this.verifySnapshot(recovery, baseline.rootHash);
      await this.initializeIsolatedGit(recovery, taskPath);
      await fs.rename(expectedWorkspace, backup);
      let installed = false;
      try {
        await fs.rename(recovery, expectedWorkspace);
        installed = true;
        await this.verifySnapshot(expectedWorkspace, baseline.rootHash);
      } catch (error) {
        if (installed) await this.removeValidated(expectedWorkspace, taskPath);
        await fs.rename(backup, expectedWorkspace);
        throw error;
      }
      await this.removeValidated(backup, taskPath);
    } finally {
      await this.removeValidated(recovery, taskPath);
    }
  }

  async pruneExpiredTaskWorkspaces(protectedTaskIds: readonly string[] = []): Promise<string[]> {
    const tasksRoot = path.join(this.root, 'tasks');
    const entries = await fs.readdir(tasksRoot, { withFileTypes: true }).catch(() => []);
    const protectedIds = new Set(protectedTaskIds);
    const cutoff = Date.now() - this.options.retentionHours * 60 * 60 * 1_000;
    const removed: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || protectedIds.has(entry.name)) continue;
      const taskPath = path.join(tasksRoot, entry.name);
      const stat = await fs.stat(taskPath);
      if (stat.mtimeMs >= cutoff) continue;
      await this.removeValidated(taskPath, tasksRoot);
      removed.push(entry.name);
    }
    return removed;
  }

  private async captureSource(
    source: string,
    destination?: string,
    includeGitMetadata = true
  ): Promise<SourceCapture> {
    const manifest: ManifestEntry[] = [];
    let fileCount = 0;
    let totalBytes = 0;

    const walk = async (directory: string, relativeDirectory = ''): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (isExcludedSourceEntry(entry.name)) continue;
        const sourceEntry = path.join(directory, entry.name);
        const relativePath = path.join(relativeDirectory, entry.name);
        const stat = await fs.lstat(sourceEntry);
        if (stat.isSymbolicLink()) {
          throw new AppError('WORKSPACE_ERROR', 'Source symbolic links are not supported', {
            path: normalizedRelative(relativePath)
          });
        }
        if (stat.isDirectory()) {
          manifest.push({
            kind: 'directory',
            path: normalizedRelative(relativePath),
            size: 0,
            mode: stat.mode & 0o777,
            sha256: hash(''),
            binary: false
          });
          if (destination) {
            await fs.mkdir(path.join(destination, relativePath), { recursive: true });
            await fs.chmod(path.join(destination, relativePath), stat.mode & 0o777);
          }
          await walk(sourceEntry, relativePath);
          continue;
        }
        if (!stat.isFile()) {
          throw new AppError('WORKSPACE_ERROR', 'Source contains an unsupported special file', {
            path: normalizedRelative(relativePath)
          });
        }
        if (ignoredSourceFileExtensions.has(path.extname(entry.name).toLowerCase())) {
          continue;
        }
        if (fileCount + 1 > this.options.maxImportFiles) {
          throw new AppError('WORKSPACE_ERROR', 'Source exceeds the import file count limit', {
            maxImportFiles: this.options.maxImportFiles
          });
        }
        const { content, mode } = await this.readBoundedFile(
          sourceEntry,
          normalizedRelative(relativePath)
        );
        totalBytes += content.length;
        if (totalBytes > this.options.maxImportBytes) {
          throw new AppError('WORKSPACE_ERROR', 'Source exceeds the total import size limit', {
            maxImportBytes: this.options.maxImportBytes
          });
        }
        const entryHash = hash(content);
        manifest.push({
          kind: 'file',
          path: normalizedRelative(relativePath),
          size: content.length,
          mode,
          sha256: entryHash,
          binary: isBinary(content)
        });
        if (destination) {
          const destinationFile = path.join(destination, relativePath);
          await fs.mkdir(path.dirname(destinationFile), { recursive: true });
          await fs.writeFile(destinationFile, content, { mode });
        }
        fileCount += 1;
      }
    };

    await walk(source);
    const git = includeGitMetadata
      ? await this.captureGitMetadata(source)
      : { isRepository: false, dirty: false };
    return {
      manifest,
      metadata: {
        capturedAt: new Date().toISOString(),
        fileCount,
        totalBytes,
        manifestHash: manifestHash(manifest),
        git
      }
    };
  }

  private async readBoundedFile(
    filePath: string,
    displayPath: string
  ): Promise<{ content: Buffer; mode: number }> {
    const handle = await fs.open(filePath, 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile()) {
        throw new AppError('WORKSPACE_ERROR', 'Source contains an unsupported special file', {
          path: displayPath
        });
      }
      if (before.size > this.options.maxFileBytes) {
        throw new AppError('WORKSPACE_ERROR', 'Source file exceeds the import size limit', {
          path: displayPath,
          size: before.size,
          maxFileBytes: this.options.maxFileBytes
        });
      }
      const buffer = Buffer.allocUnsafe(before.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (offset !== before.size || after.size !== before.size) {
        throw new AppError('WORKSPACE_ERROR', 'Source file changed while it was being imported', {
          path: displayPath
        });
      }
      return { content: buffer.subarray(0, offset), mode: before.mode & 0o777 };
    } finally {
      await handle.close();
    }
  }

  private async createSnapshot(
    taskId: string,
    workspace: string,
    kind: WorkspaceSnapshot['kind'],
    sourceRevision?: string
  ): Promise<WorkspaceSnapshot> {
    const snapshot: WorkspaceSnapshot = {
      id: randomUUID(),
      taskId,
      kind,
      rootHash: '',
      sourceRevision,
      createdAt: new Date().toISOString()
    };
    const workspaceCapture = await this.captureSource(workspace, undefined, false);
    snapshot.rootHash = workspaceCapture.metadata.manifestHash;
    const snapshotPath = path.join(this.taskPath(taskId), 'snapshots', snapshot.id);
    const snapshotsPath = path.dirname(snapshotPath);
    await fs.mkdir(snapshotsPath, { recursive: true });
    let created = false;
    try {
      await fs.mkdir(snapshotPath, { recursive: false });
      created = true;
      await this.materializeSnapshot(
        workspace,
        path.join(snapshotPath, 'tree'),
        workspaceCapture.manifest,
        kind === 'BASELINE' ? undefined : await this.latestSnapshotPath(this.taskPath(taskId))
      );
      const capture = await this.captureSource(path.join(snapshotPath, 'tree'), undefined, false);
      if (capture.metadata.manifestHash !== snapshot.rootHash) {
        throw new AppError('WORKSPACE_ERROR', 'Snapshot copy failed integrity verification');
      }
      await fs.writeFile(
        path.join(snapshotPath, 'snapshot.json'),
        `${JSON.stringify(snapshot, null, 2)}\n`,
        'utf8'
      );
      await fs.writeFile(
        path.join(snapshotPath, 'manifest.json'),
        `${JSON.stringify(capture.manifest, null, 2)}\n`,
        'utf8'
      );
      return snapshot;
    } catch (error) {
      if (created) await this.removeValidated(snapshotPath, snapshotsPath);
      throw error;
    }
  }

  private async materializeSnapshot(
    workspace: string,
    destination: string,
    manifest: ManifestEntry[],
    previousSnapshot?: string
  ): Promise<void> {
    await fs.mkdir(destination);
    let previousEntries = new Map<string, ManifestEntry>();
    if (previousSnapshot) {
      const raw = await fs
        .readFile(path.join(previousSnapshot, 'manifest.json'), 'utf8')
        .catch(() => undefined);
      if (raw) {
        try {
          previousEntries = new Map(
            (JSON.parse(raw) as ManifestEntry[]).map((entry) => [entry.path, entry])
          );
        } catch {
          previousEntries = new Map();
        }
      }
    }
    for (const entry of manifest) {
      const destinationFile = path.join(destination, entry.path);
      if (entry.kind === 'directory') {
        await fs.mkdir(destinationFile, { recursive: true, mode: entry.mode });
        await fs.chmod(destinationFile, entry.mode);
        continue;
      }
      await fs.mkdir(path.dirname(destinationFile), { recursive: true });
      const previous = previousEntries.get(entry.path);
      if (
        previousSnapshot &&
        previous?.kind === 'file' &&
        previous.sha256 === entry.sha256 &&
        previous.size === entry.size &&
        previous.mode === entry.mode
      ) {
        const previousFile = path.join(previousSnapshot, 'tree', entry.path);
        const linked = await fs
          .link(previousFile, destinationFile)
          .then(() => true)
          .catch(() => false);
        if (linked) continue;
      }
      await fs.copyFile(path.join(workspace, entry.path), destinationFile);
      await fs.chmod(destinationFile, entry.mode);
    }
  }

  private async latestSnapshotPath(taskPath: string): Promise<string | undefined> {
    const snapshotsPath = path.join(taskPath, 'snapshots');
    const entries = await fs.readdir(snapshotsPath, { withFileTypes: true }).catch(() => []);
    const candidates: Array<{ path: string; createdAt: string }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(snapshotsPath, entry.name);
      const raw = await fs
        .readFile(path.join(candidate, 'snapshot.json'), 'utf8')
        .catch(() => undefined);
      if (!raw) continue;
      try {
        const snapshot = JSON.parse(raw) as WorkspaceSnapshot;
        if (snapshot.taskId === path.basename(taskPath)) {
          candidates.push({ path: candidate, createdAt: snapshot.createdAt });
        }
      } catch {
        continue;
      }
    }
    return candidates.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.path;
  }

  private async requireBaseline(taskPath: string, expected: WorkspaceSnapshot): Promise<string> {
    if (expected.kind !== 'BASELINE' || expected.taskId !== path.basename(taskPath)) {
      throw new AppError('WORKSPACE_ERROR', 'Baseline snapshot record does not match the task');
    }
    assertIdentifier(expected.id, 'snapshotId');
    const snapshotPath = path.join(taskPath, 'snapshots', expected.id);
    const raw = await fs
      .readFile(path.join(snapshotPath, 'snapshot.json'), 'utf8')
      .catch(() => undefined);
    if (!raw) throw new AppError('WORKSPACE_ERROR', 'Baseline snapshot does not exist');
    let stored: WorkspaceSnapshot;
    try {
      stored = JSON.parse(raw) as WorkspaceSnapshot;
    } catch {
      throw new AppError('WORKSPACE_ERROR', 'Baseline snapshot metadata is invalid');
    }
    if (
      stored.id !== expected.id ||
      stored.taskId !== expected.taskId ||
      stored.kind !== expected.kind ||
      stored.rootHash !== expected.rootHash
    ) {
      throw new AppError('WORKSPACE_ERROR', 'Baseline snapshot metadata failed verification');
    }
    return snapshotPath;
  }

  private async verifySnapshot(directory: string, expectedHash: string): Promise<void> {
    const actual = (await this.captureSource(directory, undefined, false)).metadata.manifestHash;
    if (actual !== expectedHash) {
      throw new AppError('WORKSPACE_ERROR', 'Snapshot integrity verification failed', {
        expectedHash,
        actual
      });
    }
  }

  private async captureGitMetadata(source: string): Promise<SourceGitMetadata> {
    const root = await this.tryGit(source, ['rev-parse', '--show-toplevel']);
    if (!root) return { isRepository: false, dirty: false };
    const revision = await this.tryGit(source, ['rev-parse', 'HEAD']);
    const branch = await this.tryGit(source, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const status = await this.tryGit(source, ['status', '--porcelain=v1', '--untracked-files=all']);
    return {
      isRepository: true,
      root: path.resolve(root),
      revision: revision || undefined,
      branch: branch || undefined,
      dirty: Boolean(status)
    };
  }

  private async initializeIsolatedGit(workspace: string, taskPath: string): Promise<void> {
    const hooksPath = path.join(taskPath, 'git-hooks-disabled');
    await fs.mkdir(hooksPath, { recursive: true });
    await this.runGit(workspace, ['init', '--quiet', '--template=']);
    await this.runGit(workspace, ['config', '--local', 'user.name', 'CodeHarness']);
    await this.runGit(workspace, [
      'config',
      '--local',
      'user.email',
      'codeharness@localhost.invalid'
    ]);
    await this.runGit(workspace, ['config', '--local', 'core.hooksPath', hooksPath]);
    await this.runGit(workspace, ['config', '--local', 'core.autocrlf', 'false']);
    await this.runGit(workspace, ['config', '--local', 'core.fsmonitor', 'false']);
    await this.runGit(workspace, ['config', '--local', 'commit.gpgSign', 'false']);
    await this.runGit(workspace, ['add', '-A']);
    await this.runGit(workspace, [
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'CodeHarness baseline'
    ]);
  }

  private async tryGit(cwd: string, args: string[]): Promise<string | undefined> {
    try {
      return (await this.runGit(cwd, args)).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private runGit(cwd: string, args: string[], indexPath?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const environment = { ...process.env };
      delete environment.GIT_DIR;
      delete environment.GIT_WORK_TREE;
      delete environment.GIT_INDEX_FILE;
      delete environment.GIT_OBJECT_DIRECTORY;
      delete environment.GIT_ALTERNATE_OBJECT_DIRECTORIES;
      environment.GIT_TERMINAL_PROMPT = '0';
      environment.GIT_CONFIG_NOSYSTEM = '1';
      environment.GIT_CONFIG_GLOBAL = path.join(this.root, '.gitconfig-empty');
      if (indexPath) environment.GIT_INDEX_FILE = indexPath;
      const child = spawn('git', args, {
        cwd,
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.length > 10_000_000) child.kill();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > 1_000_000) child.kill();
      });
      const timer = setTimeout(() => child.kill(), config.maxCommandTimeoutMs);
      child.on('error', (error) =>
        reject(
          new AppError('WORKSPACE_ERROR', 'Git could not be started', {
            command: ['git', ...args],
            cause: error.message
          })
        )
      );
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else
          reject(
            new AppError('WORKSPACE_ERROR', 'Git command failed', {
              command: ['git', ...args],
              code,
              stderr: stderr.trim().slice(0, 4_000)
            })
          );
      });
    });
  }

  private async requireSourceDirectory(sourcePath: string): Promise<string> {
    const resolved = path.resolve(sourcePath);
    const stat = await fs.lstat(resolved).catch(() => undefined);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw new AppError('VALIDATION_ERROR', 'sourcePath must be an existing real directory', {
        sourcePath
      });
    }
    try {
      await fs.access(resolved, fsConstants.R_OK);
      return await fs.realpath(resolved);
    } catch (error) {
      throw new AppError('WORKSPACE_ERROR', 'Source directory is not readable', {
        sourcePath,
        cause: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async assertNonRecursiveSource(source: string): Promise<void> {
    const nearestRootAncestor = await this.nearestExistingPath(this.root);
    const canonicalRootCandidate = path.resolve(
      await fs.realpath(nearestRootAncestor),
      path.relative(nearestRootAncestor, this.root)
    );
    if (isWithin(source, canonicalRootCandidate) || isWithin(canonicalRootCandidate, source)) {
      throw new AppError(
        'WORKSPACE_ERROR',
        'Source directory and workspace root must not contain one another',
        { source, workspaceRoot: canonicalRootCandidate }
      );
    }
    await fs.mkdir(this.root, { recursive: true });
    const workspaceRoot = await fs.realpath(this.root);
    if (isWithin(source, workspaceRoot) || isWithin(workspaceRoot, source)) {
      throw new AppError(
        'WORKSPACE_ERROR',
        'Source directory and workspace root must not contain one another',
        { source, workspaceRoot }
      );
    }
  }

  private async requireManagedWorkspace(workspace: string): Promise<string> {
    const tasksRoot = path.resolve(this.root, 'tasks');
    const resolved = path.resolve(workspace);
    if (!isWithin(tasksRoot, resolved) || path.basename(resolved) !== 'worktree') {
      throw new AppError('FORBIDDEN', 'Workspace is not managed by CodeHarness', undefined, 403);
    }
    const stat = await fs.lstat(resolved).catch(() => undefined);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw new AppError('WORKSPACE_ERROR', 'Task workspace is missing or invalid');
    }
    const canonical = await fs.realpath(resolved);
    const canonicalRoot = await fs.realpath(tasksRoot);
    if (!isWithin(canonicalRoot, canonical)) {
      throw new AppError(
        'FORBIDDEN',
        'Workspace resolves outside the managed root',
        undefined,
        403
      );
    }
    return canonical;
  }

  private async nearestExistingPath(candidate: string): Promise<string> {
    let cursor = candidate;
    while (!(await fs.lstat(cursor).catch(() => undefined))) {
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    return cursor;
  }

  private projectPath(projectId: string): string {
    const projectsRoot = path.join(this.root, 'projects');
    const result = path.resolve(projectsRoot, projectId);
    if (!isWithin(projectsRoot, result)) {
      throw new AppError('WORKSPACE_ERROR', 'Project path escaped the workspace root');
    }
    return result;
  }

  private taskPath(taskId: string): string {
    const tasksRoot = path.join(this.root, 'tasks');
    const result = path.resolve(tasksRoot, taskId);
    if (!isWithin(tasksRoot, result)) {
      throw new AppError('WORKSPACE_ERROR', 'Task path escaped the workspace root');
    }
    return result;
  }

  private async resolveTreePath(
    root: string,
    requestedPath: string,
    allowMissing: boolean
  ): Promise<string> {
    if (
      !requestedPath ||
      requestedPath.includes('\0') ||
      path.isAbsolute(requestedPath) ||
      path.win32.isAbsolute(requestedPath)
    ) {
      throw new AppError('FORBIDDEN', 'File change path must be relative', { requestedPath }, 403);
    }
    const candidate = path.resolve(root, requestedPath);
    if (!isWithin(root, candidate)) {
      throw new AppError('FORBIDDEN', 'File change path escaped its root', { requestedPath }, 403);
    }
    let cursor = root;
    for (const part of path.relative(root, candidate).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      const stat = await fs.lstat(cursor).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' && allowMissing) return undefined;
        throw error;
      });
      if (!stat) break;
      if (stat.isSymbolicLink()) {
        throw new AppError('FORBIDDEN', 'File change path contains a symbolic link', {
          requestedPath
        });
      }
    }
    return candidate;
  }

  private async atomicCopyFile(source: string, target: string): Promise<void> {
    const sourceStat = await fs.lstat(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new AppError('WORKSPACE_ERROR', 'Apply source is not a regular file', { source });
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = path.join(path.dirname(target), `.codeharness-apply-${randomUUID()}.tmp`);
    try {
      await fs.copyFile(source, temporary);
      await fs.chmod(temporary, sourceStat.mode & 0o777);
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  private async removeValidated(target: string, parent: string): Promise<void> {
    const resolvedTarget = path.resolve(target);
    const resolvedParent = path.resolve(parent);
    if (resolvedTarget === resolvedParent || !isWithin(resolvedParent, resolvedTarget)) {
      throw new AppError('WORKSPACE_ERROR', 'Refused to remove an unsafe workspace path', {
        target
      });
    }
    await fs.rm(resolvedTarget, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50
    });
  }
}
