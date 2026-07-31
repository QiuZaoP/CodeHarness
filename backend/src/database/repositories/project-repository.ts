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

const sourceSkipReasons = new Set([
  'OVERSIZED_ARTIFACT',
  'ARTIFACT_BYTE_BUDGET',
  'ARTIFACT_FILE_BUDGET'
]);

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function isValidSkippedFiles(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 100) return false;
  return value.every((item) => {
    if (typeof item !== 'object' || item === null) return false;
    const candidate = item as Record<string, unknown>;
    return (
      typeof candidate.path === 'string' &&
      candidate.path.length > 0 &&
      Number.isSafeInteger(candidate.size) &&
      (candidate.size as number) >= 0 &&
      typeof candidate.reason === 'string' &&
      sourceSkipReasons.has(candidate.reason)
    );
  });
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
    !isOptionalNonNegativeInteger(candidate.skippedFileCount) ||
    !isOptionalNonNegativeInteger(candidate.skippedBytes) ||
    !isValidSkippedFiles(candidate.skippedFiles) ||
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

  updateSourceMetadata(id: string, sourceMetadata: SourceMetadata): ProjectRecord {
    const result = this.database
      .prepare('UPDATE projects SET source_metadata_json = ? WHERE id = ?')
      .run(stringifyStoredJson(sourceMetadata, 'project.sourceMetadata'), id);
    if (result.changes !== 1) {
      throw new AppError('NOT_FOUND', 'Project not found', { projectId: id }, 404);
    }
    return this.findById(id)!;
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

  list(): ProjectRecord[] {
    const rows = this.database
      .prepare('SELECT id FROM projects ORDER BY created_at DESC, id')
      .all() as Array<{ id: string }>;
    return rows.map(({ id }) => this.findById(id)!);
  }
}
