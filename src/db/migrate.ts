import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';

export interface MigrationOptions {
  pool: Pool;
  migrationsDir?: string;
  includeStage4Indexes?: boolean;
}

export async function runMigrations(options: MigrationOptions): Promise<string[]> {
  const {
    pool,
    migrationsDir = path.resolve(process.cwd(), 'migrations'),
    includeStage4Indexes = true,
  } = options;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => includeStage4Indexes || !f.startsWith('002_'))
    .sort();

  const appliedResult = await pool.query<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version ASC',
  );
  const applied = new Set(appliedResult.rows.map((r) => r.version));

  const newlyApplied: string[] = [];

  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version) VALUES ($1)',
        [file],
      );
      await client.query('COMMIT');
      newlyApplied.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  return newlyApplied;
}

