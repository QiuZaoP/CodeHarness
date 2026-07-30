import type Database from 'better-sqlite3';
import { assertDomainContract } from '../../event-contract.js';
import type { SnapshotKind, WorkspaceSnapshot } from '../../types.js';

interface SnapshotRow {
  id: string;
  taskId: string;
  kind: SnapshotKind;
  rootHash: string;
  sourceRevision: string | null;
  createdAt: string;
}

export class SnapshotRepository {
  constructor(private readonly database: Database.Database) {}

  create(snapshot: WorkspaceSnapshot): void {
    assertDomainContract('workspaceSnapshot', snapshot);
    this.database
      .prepare(
        'INSERT INTO workspace_snapshots (id, task_id, kind, root_hash, source_revision, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        snapshot.id,
        snapshot.taskId,
        snapshot.kind,
        snapshot.rootHash,
        snapshot.sourceRevision ?? null,
        snapshot.createdAt
      );
  }

  listByTask(taskId: string): WorkspaceSnapshot[] {
    const rows = this.database
      .prepare(
        'SELECT id, task_id as taskId, kind, root_hash as rootHash, source_revision as sourceRevision, created_at as createdAt FROM workspace_snapshots WHERE task_id = ? ORDER BY created_at, id'
      )
      .all(taskId) as SnapshotRow[];
    return rows.map((row) => {
      const snapshot: WorkspaceSnapshot = {
        id: row.id,
        taskId: row.taskId,
        kind: row.kind,
        rootHash: row.rootHash,
        sourceRevision: row.sourceRevision ?? undefined,
        createdAt: row.createdAt
      };
      assertDomainContract('workspaceSnapshot', snapshot);
      return snapshot;
    });
  }
}
