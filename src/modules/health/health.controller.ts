import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '@thallesp/nestjs-better-auth';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  // v2.0: @Public() decorator from @thallesp/nestjs-better-auth opts out
  // from its global AuthGuard.
  @Public()
  @Get()
  async check() {
    await this.db.db.execute(sql`select 1`);
    return { status: 'ok', service: 'boutica-backend', timestamp: new Date().toISOString() };
  }
}
