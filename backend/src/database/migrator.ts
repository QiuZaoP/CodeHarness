import type Database from 'better-sqlite3';
import { AppError } from '../errors.js';
import { databaseMigrations, latestDatabaseVersion } from './migrations/index.js';

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  appliedAt: string;
}

export function runDatabaseMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  for (const migration of databaseMigrations) {
    database
      .transaction(() => {
        const existing = database
          .prepare(
            'SELECT version, name, checksum, applied_at as appliedAt FROM schema_migrations WHERE version = ?'
          )
          .get(migration.version) as AppliedMigration | undefined;
        if (existing) {
          if (existing.name !== migration.name || existing.checksum !== migration.checksum) {
            throw new AppError(
              'INTERNAL_ERROR',
              `Database migration ${migration.version} does not match the application`,
              {
                expectedName: migration.name,
                expectedChecksum: migration.checksum,
                actual: existing
              },
              500
            );
          }
          return;
        }
        migration.up(database);
        database
          .prepare(
            'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)'
          )
          .run(migration.version, migration.name, migration.checksum, new Date().toISOString());
      })
      .immediate();
  }

  database.pragma(`user_version = ${latestDatabaseVersion}`);
  const foreignKeyViolations = database.pragma('foreign_key_check') as unknown[];
  if (foreignKeyViolations.length > 0) {
    throw new AppError(
      'INTERNAL_ERROR',
      'Database contains foreign key violations',
      { violations: foreignKeyViolations },
      500
    );
  }
}

export function getAppliedMigrations(database: Database.Database): AppliedMigration[] {
  return database
    .prepare(
      'SELECT version, name, checksum, applied_at as appliedAt FROM schema_migrations ORDER BY version'
    )
    .all() as AppliedMigration[];
}
