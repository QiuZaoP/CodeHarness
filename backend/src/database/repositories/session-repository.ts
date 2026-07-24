import type Database from 'better-sqlite3';
import type { Message } from '../../types.js';
import type { SessionRecord } from '../records.js';

export class SessionRepository {
  constructor(private readonly database: Database.Database) {}

  create(record: SessionRecord): void {
    this.database
      .prepare('INSERT INTO sessions (id, project_id, title, created_at) VALUES (?, ?, ?, ?)')
      .run(record.id, record.projectId, record.title, record.createdAt);
  }

  findById(id: string): SessionRecord | undefined {
    return this.database
      .prepare(
        'SELECT id, project_id as projectId, title, created_at as createdAt FROM sessions WHERE id = ?'
      )
      .get(id) as SessionRecord | undefined;
  }

  createMessage(message: Message): void {
    this.database
      .prepare(
        'INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(message.id, message.sessionId, message.role, message.content, message.createdAt);
  }

  listMessages(sessionId: string): Message[] {
    return this.database
      .prepare(
        'SELECT id, session_id as sessionId, role, content, created_at as createdAt FROM messages WHERE session_id = ? ORDER BY created_at, id'
      )
      .all(sessionId) as Message[];
  }
}
