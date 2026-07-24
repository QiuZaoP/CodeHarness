import type Database from 'better-sqlite3';
import { AppError } from '../../errors.js';
import type { ProjectRecord } from '../records.js';
import { parseStoredJson, stringifyStoredJson } from '../stored-json.js';
import type { SourceMetadata } from '../../types.js';

interface ProjectRow {
  id: string;
  name: string;
  sourcePath: string;
  workspacePath: string;
  sourceMetadataJson: string | null;
  createdAt: string;
}

function parseSourceMetadata(raw: string): SourceMetadata {
  const value = parseStoredJson<unknown>(raw, 'project.sourceMetadata');
  if (typeof value !== 'object' || value === null) {
    throw new AppError(
      'INTERNAL_ERROR',
      'Stored project source metadata is invalid',
      undefined,
      500
    );
  }
  const candidate = value as Record<string, unknown>;
  const git =
    typeof candidate.git === 'object' && candidate.git !== null
      ? (candidate.git as Record<string, unknown>)
      : undefined;
  const optionalString = (field: unknown) => field === undefined || typeof field === 'string';
  if (
    typeof candidate.capturedAt !== 'string' ||
    Number.isNaN(Date.parse(candidate.capturedAt)) ||
    !Number.isSafeInteger(candidate.fileCount) ||
    (candidate.fileCount as number) < 0 ||
    !Number.isSafeInteger(candidate.totalBytes) ||
    (candidate.totalBytes as number) < 0 ||
    typeof candidate.manifestHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(candidate.manifestHash) ||
    !git ||
    typeof git.isRepository !== 'boolean' ||
    typeof git.dirty !== 'boolean' ||
    !optionalString(git.root) ||
    !optionalString(git.revision) ||
    !optionalString(git.branch)
  ) {
    throw new AppError(
      'INTERNAL_ERROR',
      'Stored project source metadata is invalid',
      undefined,
      500
    );
  }
  return value as SourceMetadata;
}

export class ProjectRepository {
  constructor(private readonly database: Database.Database) {}

  create(record: ProjectRecord): void {
    this.database
      .prepare(
        'INSERT INTO projects (id, name, source_path, workspace_path, source_metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        record.id,
        record.name,
        record.sourcePath,
        record.workspacePath,
        record.sourceMetadata
          ? stringifyStoredJson(record.sourceMetadata, 'project.sourceMetadata')
          : null,
        record.createdAt
      );
  }

  findById(id: string): ProjectRecord | undefined {
    const row = this.database
      .prepare(
        'SELECT id, name, source_path as sourcePath, workspace_path as workspacePath, source_metadata_json as sourceMetadataJson, created_at as createdAt FROM projects WHERE id = ?'
      )
      .get(id) as ProjectRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      sourcePath: row.sourcePath,
      workspacePath: row.workspacePath,
      sourceMetadata: row.sourceMetadataJson
        ? parseSourceMetadata(row.sourceMetadataJson)
        : undefined,
      createdAt: row.createdAt
    };
  }
}
