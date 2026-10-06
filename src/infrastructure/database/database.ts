import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

/**
 * ROUND 2 FIX: this file used to read `process.env.DATABASE_URL` directly,
 * unvalidated, in a dense one-line style that was out of step with the rest
 * of the codebase (it looks like it was missed by the round-1 pass — every
 * other infrastructure file was reformatted and had its env access moved
 * behind validation). `DATABASE_URL` is now guaranteed present and
 * non-empty by `envSchema` (see src/config/env.schema.ts), validated once
 * at bootstrap instead of failing lazily on the first query.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly pool: Pool;
  readonly db: NodePgDatabase<typeof schema>;

  constructor(config: ConfigService) {
    this.pool = new Pool({
      connectionString: config.get<string>('DATABASE_URL'),
      max: 10,
      idleTimeoutMillis: 30_000,
    });
    this.db = drizzle(this.pool, { schema });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
