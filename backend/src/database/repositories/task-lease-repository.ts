import type Database from 'better-sqlite3';
import type { TaskLease } from '../../types.js';

export class TaskLeaseRepository {
  constructor(private readonly database: Database.Database) {}

  acquire(
    taskId: string,
    ownerId: string,
    acquiredAt: string,
    expiresAt: string
  ): TaskLease | undefined {
    const result = this.database
      .prepare(
        `INSERT INTO task_leases (task_id, owner_id, acquired_at, expires_at, version)
         VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(task_id) DO UPDATE SET
           owner_id = excluded.owner_id,
           acquired_at = excluded.acquired_at,
           expires_at = excluded.expires_at,
           version = task_leases.version + 1
         WHERE task_leases.expires_at <= excluded.acquired_at`
      )
      .run(taskId, ownerId, acquiredAt, expiresAt);
    return result.changes === 1 ? this.find(taskId) : undefined;
  }

  renew(
    taskId: string,
    ownerId: string,
    renewedAt: string,
    expiresAt: string
  ): TaskLease | undefined {
    const result = this.database
      .prepare(
        `UPDATE task_leases
         SET expires_at = ?, version = version + 1
         WHERE task_id = ? AND owner_id = ? AND expires_at > ?`
      )
      .run(expiresAt, taskId, ownerId, renewedAt);
    return result.changes === 1 ? this.find(taskId) : undefined;
  }

  find(taskId: string): TaskLease | undefined {
    return this.database
      .prepare(
        `SELECT task_id as taskId, owner_id as ownerId, acquired_at as acquiredAt,
                expires_at as expiresAt, version
         FROM task_leases WHERE task_id = ?`
      )
      .get(taskId) as TaskLease | undefined;
  }

  release(taskId: string, ownerId: string): boolean {
    return (
      this.database
        .prepare('DELETE FROM task_leases WHERE task_id = ? AND owner_id = ?')
        .run(taskId, ownerId).changes === 1
    );
  }

  releaseExpired(taskId: string, now: string): boolean {
    return (
      this.database
        .prepare('DELETE FROM task_leases WHERE task_id = ? AND expires_at <= ?')
        .run(taskId, now).changes === 1
    );
  }
}
