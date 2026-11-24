import { Module, forwardRef } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { CasService } from './cas.service';
import { AuthGuard, OptionalAuthGuard } from './auth.guard';
import { LibraryModule } from '../library/library.module';

@Module({
  imports: [forwardRef(() => LibraryModule)],
  controllers: [AuthController],
  providers: [CasService, AuthGuard, OptionalAuthGuard],
  exports: [CasService, AuthGuard, OptionalAuthGuard],
})
export class AuthModule {}
