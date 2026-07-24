import type Database from 'better-sqlite3';
import { contractSchemaVersion } from '../../contract-values.js';
import { assertTaskEventContract } from '../../event-contract.js';
import type { EventType, TaskEvent } from '../../types.js';
import { parseStoredJson, stringifyStoredJson } from '../stored-json.js';

export type NewTaskEvent = Omit<TaskEvent, 'id' | 'schemaVersion'>;

export class EventRepository {
  constructor(private readonly database: Database.Database) {}

  create(event: NewTaskEvent): TaskEvent {
    assertTaskEventContract({ ...event, schemaVersion: contractSchemaVersion, id: 1 });
    const result = this.database
      .prepare(
        'INSERT INTO task_events (task_id, type, timestamp, payload_json, schema_version) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        event.taskId,
        event.type,
        event.timestamp,
        stringifyStoredJson(event.payload, `task event ${event.type}`),
        contractSchemaVersion
      );
    const storedEvent: TaskEvent = {
      ...event,
      schemaVersion: contractSchemaVersion,
      id: Number(result.lastInsertRowid)
    };
    assertTaskEventContract(storedEvent);
    return storedEvent;
  }

  listByTask(taskId: string, afterId = 0): TaskEvent[] {
    const rows = this.database
      .prepare(
        'SELECT id, task_id as taskId, type, timestamp, payload_json as payloadJson, schema_version as schemaVersion FROM task_events WHERE task_id = ? AND id > ? ORDER BY id ASC'
      )
      .all(taskId, afterId) as Array<{
      id: number;
      taskId: string;
      type: EventType;
      timestamp: string;
      payloadJson: string;
      schemaVersion: typeof contractSchemaVersion;
    }>;
    return rows.map(({ payloadJson, ...event }) => {
      const storedEvent: TaskEvent = {
        ...event,
        payload: parseStoredJson<Record<string, unknown>>(
          payloadJson,
          `task event ${event.id} payload`
        )
      };
      assertTaskEventContract(storedEvent);
      return storedEvent;
    });
  }
}
