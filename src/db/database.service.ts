import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { createInfrastructureError } from '../common/errors/domain-errors';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor() {
    const connectionString =
      process.env.DATABASE_URL ||
      'postgresql://shodh:shodh_secret@localhost:5432/shodh_contest';
    this.pool = new Pool({
      connectionString,
      max: Number(process.env.DB_POOL_MAX || 25),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }

  public getPool(): Pool {
    return this.pool;
  }

  public async query<T extends QueryResultRow = any>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    try {
      return await this.pool.query<T>(sql, params);
    } catch (err: any) {
      if (this.isConnectionError(err)) {
        throw createInfrastructureError(
          'DATABASE_UNAVAILABLE',
          'Database connection or infrastructure error occurred',
          { pgCode: err?.code },
        );
      }
      throw err;
    }
  }

  public async withTransaction<T>(
    fn: (client: PoolClient) => Promise<T>,
    isolationLevel: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE' = 'READ COMMITTED',
  ): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (err: any) {
      throw createInfrastructureError(
        'DATABASE_UNAVAILABLE',
        'Failed to acquire database connection for transaction',
        { pgCode: err?.code },
      );
    }

    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback failure if connection dropped
      }
      throw err;
    } finally {
      client.release();
    }
  }

  private isConnectionError(err: any): boolean {
    if (!err) return false;
    const connectionCodes = new Set([
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      '57P01',
      '57P02',
      '57P03',
      '08000',
      '08003',
      '08006',
    ]);
    return connectionCodes.has(err.code);
  }

  public async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
