import type Database from 'better-sqlite3';
import type { PlanStep } from '../../types.js';

export class TaskStepRepository {
  constructor(private readonly database: Database.Database) {}

  replaceForTask(taskId: string, steps: readonly PlanStep[], timestamp: string): void {
    this.database.prepare('DELETE FROM task_steps WHERE task_id = ?').run(taskId);
    const insert = this.database.prepare(
      'INSERT INTO task_steps (id, task_id, title, status, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    steps.forEach((step, position) => {
      insert.run(step.id, taskId, step.title, step.status, position, timestamp, timestamp);
    });
  }
}
