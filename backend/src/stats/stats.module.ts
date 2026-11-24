import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LibraryModule } from '../library/library.module';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

@Module({
  imports: [AuthModule, LibraryModule],
  controllers: [StatsController],
  providers: [StatsService],
  exports: [StatsService],
})
export class StatsModule {}
