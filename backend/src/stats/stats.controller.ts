import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { OptionalAuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { CasService } from '../auth/cas.service';
import { StatsService } from './stats.service';

@Controller('stats')
export class StatsController {
  constructor(
    private readonly statsService: StatsService,
    private readonly casService: CasService,
  ) {}

  @Post('visit')
  recordVisit(@Req() req: Request, @Body() body?: { path?: string }) {
    const ip = this.casService.getClientIp(req);
    const ua = String(req.headers['user-agent'] || '');
    return this.statsService.recordVisit(ip, ua, body?.path || '/');
  }

  @UseGuards(OptionalAuthGuard)
  @Get('overview')
  getOverview(@Req() req: AuthenticatedRequest) {
    return this.statsService.getOverview(req.user);
  }

  @UseGuards(OptionalAuthGuard)
  @Get('card')
  queryCard(@Req() req: AuthenticatedRequest, @Query('query') query?: string) {
    return this.statsService.queryReservationCard(query || '', req.user);
  }

  @UseGuards(OptionalAuthGuard)
  @Get('cards/leaderboard')
  getLeaderboard(@Req() req: AuthenticatedRequest) {
    return {
      cards: this.statsService.getCardLeaderboard(req.user),
    };
  }
}
