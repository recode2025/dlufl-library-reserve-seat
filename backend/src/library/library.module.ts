import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IcspService } from './icspace.service';
import { SchedulerService } from './scheduler.service';
import { LibraryController } from './library.controller';

@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [LibraryController],
  providers: [IcspService, SchedulerService],
  exports: [IcspService, SchedulerService],
})
export class LibraryModule {}
