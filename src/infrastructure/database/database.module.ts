import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database';

// ROUND 2 FIX: reformatted to match the rest of the codebase (this file
// was apparently missed by the round-1 pass — it was still in the original
// dense, single-line style). No behavior change.
@Global()
@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
