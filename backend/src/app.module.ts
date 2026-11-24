import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { LibraryModule } from './library/library.module';
import { StatsModule } from './stats/stats.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    DatabaseModule,
    AuthModule,
    LibraryModule,
    StatsModule,
  ],
})
export class AppModule {}
