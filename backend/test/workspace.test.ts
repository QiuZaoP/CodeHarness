import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WorkspaceManager } from '../src/workspace.js';

const run = promisify(execFile);

async function fixture(): Promise<{
  root: string;
  source: string;
  manager: WorkspaceManager;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codeharness-workspace-'));
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'README.md'), '# Original\n');
  await fs.mkdir(path.join(source, 'src'));
  await fs.writeFile(path.join(source, 'src', 'index.ts'), 'export const answer = 42;\n');
  await fs.mkdir(path.join(source, 'empty'));
  return {
    root,
    source,
    manager: new WorkspaceManager({ root: path.join(root, 'managed') })
  };
}

describe('task workspace isolation', () => {
  it('refreshes the imported manifest after source files change', async () => {
    const { source, manager } = await fixture();
    const projectId = randomUUID();
    const imported = await manager.importProject(source, projectId);
    expect(imported.metadata.fileCount).toBe(2);

    await fs.writeFile(path.join(source, 'generated.txt'), 'generated\n');
    const refreshed = await manager.refreshImportedProject(source, projectId);
    const sourceMetadata = JSON.parse(
      await fs.readFile(path.join(imported.projectPath, 'source-metadata', 'source.json'), 'utf8')
    ) as { fileCount: number; manifestHash: string };

    expect(refreshed.metadata.fileCount).toBe(3);
    expect(sourceMetadata).toMatchObject({
      fileCount: 3,
      manifestHash: refreshed.metadata.manifestHash
    });
    await expect(manager.listImportedFiles(projectId)).resolves.toEqual({
      files: expect.arrayContaining(['README.md', 'generated.txt', 'src/index.ts'])
    });
  });

  it('isolates tasks, reports a complete diff, and restores a verified baseline', async () => {
    const { root, source, manager } = await fixture();
    const projectId = randomUUID();
    const imported = await manager.importProject(source, projectId);
    const firstId = randomUUID();
    const secondId = randomUUID();
    const first = await manager.createTaskWorkspace(projectId, firstId, source);
    const second = await manager.createTaskWorkspace(projectId, secondId, source);

    expect(first.workspacePath).not.toBe(second.workspacePath);
    expect(imported.metadata).toMatchObject({ fileCount: 2, totalBytes: expect.any(Number) });
    expect(
      (await fs.stat(path.join(imported.projectPath, 'source-metadata', 'manifest.json'))).isFile()
    ).toBe(true);

    await fs.writeFile(path.join(first.workspacePath, 'README.md'), '# Changed\n');
    await fs.writeFile(path.join(first.workspacePath, 'new.txt'), 'new file\n');
    await fs.rm(path.join(first.workspacePath, 'empty'), { recursive: true });
    const status = await manager.getStatus(first.workspacePath);
    const diff = await manager.getDiff(first.workspacePath);
    expect(status.clean).toBe(false);
    expect(status.entries.join('\n')).toContain('README.md');
    expect(diff).toContain('diff --git a/README.md b/README.md');
    expect(diff).toContain('diff --git a/new.txt b/new.txt');
    expect(await fs.readFile(path.join(second.workspacePath, 'README.md'), 'utf8')).toBe(
      '# Original\n'
    );
    expect(await fs.readFile(path.join(source, 'README.md'), 'utf8')).toBe('# Original\n');
    expect(await fs.stat(path.join(source, '.git')).catch(() => undefined)).toBeUndefined();

    const snapshotsPath = path.join(root, 'managed', 'tasks', firstId, 'snapshots');
    const checkpoint = await manager.createCheckpoint(firstId, first.workspacePath);
    const baselineIndex = await fs.stat(
      path.join(snapshotsPath, first.baseline.id, 'tree', 'src', 'index.ts')
    );
    const checkpointIndex = await fs.stat(
      path.join(snapshotsPath, checkpoint.id, 'tree', 'src', 'index.ts')
    );
    expect(checkpoint.kind).toBe('CHECKPOINT');
    expect(checkpoint.rootHash).not.toBe(first.baseline.rootHash);
    expect(checkpointIndex.ino).toBe(baselineIndex.ino);
    expect(checkpointIndex.nlink).toBeGreaterThanOrEqual(2);
    const snapshotsBefore = (await fs.readdir(snapshotsPath)).sort();
    await manager.rollback(firstId, first.workspacePath, first.baseline);
    expect(await fs.readFile(path.join(first.workspacePath, 'README.md'), 'utf8')).toBe(
      '# Original\n'
    );
    expect((await fs.stat(path.join(first.workspacePath, 'empty'))).isDirectory()).toBe(true);
    expect(await fs.stat(path.join(first.workspacePath, 'new.txt')).catch(() => undefined)).toBe(
      undefined
    );
    expect(await manager.getStatus(first.workspacePath)).toEqual({ clean: true, entries: [] });
    expect((await fs.readdir(snapshotsPath)).sort()).toEqual(snapshotsBefore);

    await fs.writeFile(path.join(first.workspacePath, 'README.md'), '# Keep on failure\n');
    await fs.writeFile(
      path.join(snapshotsPath, first.baseline.id, 'tree', 'README.md'),
      '# Tampered snapshot\n'
    );
    await expect(manager.rollback(firstId, first.workspacePath, first.baseline)).rejects.toThrow(
      'integrity verification failed'
    );
    expect(await fs.readFile(path.join(first.workspacePath, 'README.md'), 'utf8')).toBe(
      '# Keep on failure\n'
    );
    expect((await fs.readdir(snapshotsPath)).sort()).toEqual(snapshotsBefore);
  }, 15_000);

  it('blocks traversal, absolute paths, and symbolic-link escapes', async () => {
    const { root, source, manager } = await fixture();
    const taskId = randomUUID();
    await manager.importProject(source, randomUUID());
    const task = await manager.createTaskWorkspace(randomUUID(), taskId, source);

    await expect(manager.resolve(task.workspacePath, '../outside.txt', 'write')).rejects.toThrow(
      'outside the task workspace'
    );
    await expect(
      manager.resolve(task.workspacePath, path.join(root, 'outside.txt'))
    ).rejects.toThrow('Only relative paths');

    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    const link = path.join(task.workspacePath, 'escape');
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(manager.resolve(task.workspacePath, 'escape/file.txt', 'write')).rejects.toThrow(
      'Symbolic links are not allowed'
    );
  });

  it('rejects source links and enforces file-count and file-size limits', async () => {
    const linkedFixture = await fixture();
    const outside = path.join(linkedFixture.root, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'outside.txt'), 'outside\n');
    await fs.symlink(
      outside,
      path.join(linkedFixture.source, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    await expect(
      linkedFixture.manager.importProject(linkedFixture.source, randomUUID())
    ).rejects.toThrow('Source symbolic links are not supported');

    const limitedFixture = await fixture();
    const countLimited = new WorkspaceManager({
      root: path.join(limitedFixture.root, 'count-managed'),
      maxImportFiles: 1
    });
    await expect(countLimited.importProject(limitedFixture.source, randomUUID())).rejects.toThrow(
      'file count limit'
    );
    const sizeLimited = new WorkspaceManager({
      root: path.join(limitedFixture.root, 'size-managed'),
      maxFileBytes: 4
    });
    await expect(sizeLimited.importProject(limitedFixture.source, randomUUID())).rejects.toThrow(
      'file exceeds the import size limit'
    );
    const totalLimited = new WorkspaceManager({
      root: path.join(limitedFixture.root, 'total-managed'),
      maxImportBytes: 20
    });
    await expect(totalLimited.importProject(limitedFixture.source, randomUUID())).rejects.toThrow(
      'total import size limit'
    );

    const recursiveRoot = path.join(limitedFixture.source, 'managed');
    const recursive = new WorkspaceManager({ root: recursiveRoot });
    await expect(recursive.importProject(limitedFixture.source, randomUUID())).rejects.toThrow(
      'must not contain one another'
    );
    expect(await fs.stat(recursiveRoot).catch(() => undefined)).toBeUndefined();
  });

  it('ignores pytest run artifacts while importing a source directory', async () => {
    const { source, manager } = await fixture();
    const artifact = path.join(source, '.pytest_run_all', 'locked-artifact');
    await fs.mkdir(artifact, { recursive: true });
    await fs.writeFile(path.join(artifact, 'result.txt'), 'temporary test output\n');
    await fs.writeFile(path.join(source, 'cache.sqlite3'), Buffer.alloc(6 * 1024 * 1024));

    const imported = await manager.importProject(source, randomUUID());

    expect(imported.metadata.fileCount).toBe(2);
    expect(
      await fs.stat(path.join(imported.projectPath, 'source-metadata', 'manifest.json'))
    ).toBeDefined();
  });

  it('keeps source files while skipping oversized and bulk project artifacts', async () => {
    const { root, source } = await fixture();
    await fs.mkdir(path.join(source, 'assets'));
    await fs.writeFile(path.join(source, 'assets', 'a.png'), Buffer.alloc(6, 1));
    await fs.writeFile(path.join(source, 'assets', 'b.png'), Buffer.alloc(6, 2));
    await fs.writeFile(path.join(source, 'dataset.csv'), 'value\n1\n');
    await fs.writeFile(path.join(source, 'model.onnx'), Buffer.alloc(64));
    await fs.writeFile(path.join(source, 'tasks.json'), JSON.stringify({ data: 'x'.repeat(64) }));
    const manager = new WorkspaceManager({
      root: path.join(root, 'artifact-managed'),
      maxFileBytes: 32,
      maxImportArtifactBytes: 10,
      maxImportArtifactFiles: 10
    });

    const projectId = randomUUID();
    const imported = await manager.importProject(source, projectId);
    const task = await manager.createTaskWorkspace(projectId, randomUUID(), source);

    expect(imported.metadata).toMatchObject({
      fileCount: 3,
      skippedFileCount: 4,
      skippedBytes: expect.any(Number),
      skippedFiles: expect.arrayContaining([
        expect.objectContaining({ path: 'assets/b.png', reason: 'ARTIFACT_BYTE_BUDGET' }),
        expect.objectContaining({ path: 'dataset.csv', reason: 'ARTIFACT_BYTE_BUDGET' }),
        expect.objectContaining({ path: 'model.onnx', reason: 'OVERSIZED_ARTIFACT' }),
        expect.objectContaining({ path: 'tasks.json', reason: 'OVERSIZED_ARTIFACT' })
      ])
    });
    expect(await fs.readFile(path.join(task.workspacePath, 'README.md'), 'utf8')).toBe(
      '# Original\n'
    );
    expect(await fs.stat(path.join(task.workspacePath, 'assets', 'a.png'))).toBeDefined();
    expect(
      await fs.stat(path.join(task.workspacePath, 'assets', 'b.png')).catch(() => undefined)
    ).toBeUndefined();
    expect(
      await fs.stat(path.join(task.workspacePath, 'model.onnx')).catch(() => undefined)
    ).toBeUndefined();
    expect(
      await fs.stat(path.join(task.workspacePath, 'tasks.json')).catch(() => undefined)
    ).toBeUndefined();
  });

  it('still rejects oversized source code instead of silently dropping it', async () => {
    const { root, source } = await fixture();
    await fs.writeFile(
      path.join(source, 'src', 'huge.ts'),
      `export const value = '${'x'.repeat(64)}';\n`
    );
    const manager = new WorkspaceManager({
      root: path.join(root, 'source-limit-managed'),
      maxFileBytes: 32
    });

    await expect(manager.importProject(source, randomUUID())).rejects.toThrow(
      'Source file exceeds the import size limit'
    );
  });

  it('captures source Git revision, branch, and dirty state without changing the source', async () => {
    const { root, source, manager } = await fixture();
    await run('git', ['init', '--quiet'], { cwd: source });
    await run('git', ['config', 'user.name', 'Fixture'], { cwd: source });
    await run('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: source });
    await run('git', ['add', '-A'], { cwd: source });
    await run('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: source });
    await fs.writeFile(path.join(source, 'README.md'), '# Dirty\n');
    const before = await run('git', ['status', '--porcelain=v1'], { cwd: source });

    const imported = await manager.importProject(source, randomUUID());
    const after = await run('git', ['status', '--porcelain=v1'], { cwd: source });

    expect(imported.metadata.git).toMatchObject({
      isRepository: true,
      revision: expect.stringMatching(/^[0-9a-f]{40}$/),
      branch: expect.any(String),
      dirty: true
    });
    expect(after.stdout).toBe(before.stdout);
    expect(path.dirname(imported.projectPath)).toBe(path.join(root, 'managed', 'projects'));
  });

  it('prunes only expired terminal workspaces that are not protected', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codeharness-retention-'));
    const managed = path.join(root, 'managed');
    const tasks = path.join(managed, 'tasks');
    const expiredId = randomUUID();
    const protectedId = randomUUID();
    const recentId = randomUUID();
    await fs.mkdir(path.join(tasks, expiredId), { recursive: true });
    await fs.mkdir(path.join(tasks, protectedId), { recursive: true });
    await fs.mkdir(path.join(tasks, recentId), { recursive: true });
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    await fs.utimes(path.join(tasks, expiredId), old, old);
    await fs.utimes(path.join(tasks, protectedId), old, old);
    const manager = new WorkspaceManager({ root: managed, retentionHours: 1 });

    await expect(manager.pruneExpiredTaskWorkspaces([protectedId])).resolves.toEqual([expiredId]);
    await expect(fs.stat(path.join(tasks, expiredId))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(path.join(tasks, protectedId))).isDirectory()).toBe(true);
    expect((await fs.stat(path.join(tasks, recentId))).isDirectory()).toBe(true);
  });
});
