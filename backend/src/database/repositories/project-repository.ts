import type Database from 'better-sqlite3';
import type { ProjectRecord } from '../records.js';

export class ProjectRepository {
  constructor(private readonly database: Database.Database) {}

  create(record: ProjectRecord): void {
    this.database
      .prepare(
        'INSERT INTO projects (id, name, source_path, workspace_path, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(record.id, record.name, record.sourcePath, record.workspacePath, record.createdAt);
  }

  findById(id: string): ProjectRecord | undefined {
    return this.database
      .prepare(
        'SELECT id, name, source_path as sourcePath, workspace_path as workspacePath, created_at as createdAt FROM projects WHERE id = ?'
      )
      .get(id) as ProjectRecord | undefined;
  }
}
