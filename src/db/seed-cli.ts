import { Pool } from 'pg';
import { runMigrations } from './migrate';
import { seedDeterministicData } from './seed';

async function main() {
  const connectionString =
    process.env.DATABASE_URL ||
    'postgresql://shodh:shodh_secret@localhost:5432/shodh_contest';
  const pool = new Pool({ connectionString });
  try {
    await runMigrations({ pool });
    const summary = await seedDeterministicData(pool, {
      resetExisting: process.argv.includes('--reset'),
    });
    console.log(
      JSON.stringify({
        event: 'seed_completed',
        ...summary,
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
