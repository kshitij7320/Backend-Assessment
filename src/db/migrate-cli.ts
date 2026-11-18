import { Pool } from 'pg';
import { runMigrations } from './migrate';

async function main() {
  const connectionString =
    process.env.DATABASE_URL ||
    'postgresql://shodh:shodh_secret@localhost:5432/shodh_contest';
  const pool = new Pool({ connectionString });
  try {
    const applied = await runMigrations({ pool });
    console.log(
      JSON.stringify({
        event: 'migrations_completed',
        applied,
      }),
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

