import type Database from 'better-sqlite3';
import type { AuditRecord } from '../../types.js';
import { parseStoredJson, stringifyStoredJson } from '../stored-json.js';

export interface StoredAuditRecord extends AuditRecord {
  taskId?: string;
}

interface AuditRow {
  id: string;
  taskId: string | null;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  beforeJson: string | null;
  afterJson: string | null;
  timestamp: string;
}

export class AuditRepository {
  constructor(private readonly database: Database.Database) {}

  create(record: StoredAuditRecord): void {
    this.database
      .prepare(
        'INSERT INTO audit_records (id, task_id, actor_id, action, resource_type, resource_id, before_json, after_json, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        record.id,
        record.taskId ?? null,
        record.actorId ?? null,
        record.action,
        record.resourceType,
        record.resourceId,
        record.before === undefined
          ? null
          : stringifyStoredJson(record.before, `audit ${record.id} before`),
        record.after === undefined
          ? null
          : stringifyStoredJson(record.after, `audit ${record.id} after`),
        record.timestamp
      );
  }

  listForResource(resourceType: string, resourceId: string): StoredAuditRecord[] {
    const rows = this.database
      .prepare(
        'SELECT id, task_id as taskId, actor_id as actorId, action, resource_type as resourceType, resource_id as resourceId, before_json as beforeJson, after_json as afterJson, timestamp FROM audit_records WHERE resource_type = ? AND resource_id = ? ORDER BY timestamp, id'
      )
      .all(resourceType, resourceId) as AuditRow[];
    return rows.map((row) => ({
      id: row.id,
      taskId: row.taskId ?? undefined,
      actorId: row.actorId ?? undefined,
      action: row.action,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      before: row.beforeJson
        ? parseStoredJson(row.beforeJson, `audit ${row.id} before`)
        : undefined,
      after: row.afterJson ? parseStoredJson(row.afterJson, `audit ${row.id} after`) : undefined,
      timestamp: row.timestamp
    }));
  }
}
