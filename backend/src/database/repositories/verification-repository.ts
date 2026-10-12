import type Database from 'better-sqlite3';
import { assertDomainContract } from '../../event-contract.js';
import type {
  VerificationFailureCategory,
  VerificationResult,
  VerificationStatus
} from '../../types.js';

interface VerificationRow {
  id: string;
  taskId: string;
  command: string;
  status: VerificationStatus;
  exitCode: number | null;
  outputSummary: string;
  failureCategory: VerificationFailureCategory | null;
  createdAt: string;
}

export class VerificationRepository {
  constructor(private readonly database: Database.Database) {}

  create(result: VerificationResult): void {
    assertDomainContract('verificationResult', result);
    this.database
      .prepare(
        'INSERT INTO verification_results (id, task_id, command, status, exit_code, output_summary, failure_category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        result.id,
        result.taskId,
        result.command,
        result.status,
        result.exitCode ?? null,
        result.outputSummary,
        result.failureCategory ?? null,
        result.createdAt
      );
  }

  listByTask(taskId: string): VerificationResult[] {
    const rows = this.database
      .prepare(
        'SELECT id, task_id as taskId, command, status, exit_code as exitCode, output_summary as outputSummary, failure_category as failureCategory, created_at as createdAt FROM verification_results WHERE task_id = ? ORDER BY created_at, id'
      )
      .all(taskId) as VerificationRow[];
    return rows.map((row) => {
      const result: VerificationResult = {
        id: row.id,
        taskId: row.taskId,
        command: row.command,
        status: row.status,
        exitCode: row.exitCode ?? undefined,
        outputSummary: row.outputSummary,
        failureCategory: row.failureCategory ?? undefined,
        createdAt: row.createdAt
      };
      assertDomainContract('verificationResult', result);
      return result;
    });
  }
}
