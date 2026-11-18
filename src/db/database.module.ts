import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { StructuredLoggerService } from '../common/logger/structured-logger.service';

@Global()
@Module({
  providers: [DatabaseService, StructuredLoggerService],
  exports: [DatabaseService, StructuredLoggerService],
})
export class DatabaseModule {}
