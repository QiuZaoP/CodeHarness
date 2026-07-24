import type Database from 'better-sqlite3';

export interface DatabaseMigration {
  version: number;
  name: string;
  checksum: string;
  up(database: Database.Database): void;
}
