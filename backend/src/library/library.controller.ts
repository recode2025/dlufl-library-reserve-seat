import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard, OptionalAuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { DatabaseService, ReservationRow } from '../database/database.service';
import { IcspService } from './icspace.service';
import { CreateScheduleDto, SchedulerService } from './scheduler.service';

@Controller('library')
export class LibraryController {
  constructor(
    private readonly icspService: IcspService,
    private readonly schedulerService: SchedulerService,
    private readonly dbService: DatabaseService,
  ) {}

  @Get('areas')
  getAreas() {
    return {
      areas: this.icspService.getAreas(),
      countdown: this.schedulerService.getNextReleaseCountdown(),
    };
  }

  @UseGuards(OptionalAuthGuard)
  @Get('areas/:areaId/floorplan')
  async getAreaFloorPlan(
    @Req() req: AuthenticatedRequest,
    @Param('areaId') areaId: string,
    @Res() res: Response,
  ) {
    const img = await this.icspService.getAreaFloorPlanImage(req.user, areaId);
    if (!img) {
      throw new NotFoundException('暂未获取到该区域平面底图');
    }
    res.setHeader('ETag', img.etag);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (req.headers['if-none-match'] === img.etag) {
      return res.status(304).end();
    }
    res.setHeader('Content-Type', img.contentType);
    return res.send(img.buffer);
  }

  @UseGuards(OptionalAuthGuard)
  @Get('seats')
  async getSeats(
    @Req() req: AuthenticatedRequest,
    @Query('areaId') areaId?: string,
    @Query('date') date?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ) {
    const targetAreaId = areaId || this.icspService.getAreas()[1].id;
    const today = this.schedulerService.formatDateLocal(new Date());
    const targetDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today;
    return await this.icspService.fetchAreaSeats(
      req.user,
      targetAreaId,
      targetDate,
      startTime || '08:30',
      endTime || '22:00',
    );
  }

  @UseGuards(AuthGuard)
  @Post('reserve')
  async reserveSeat(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: {
      areaId?: string;
      devId?: string;
      seatName?: string;
      targetDate?: string;
      startTime?: string;
      endTime?: string;
    },
  ) {
    if (!body?.areaId || !body?.devId || !body?.seatName || !body?.targetDate) {
      throw new BadRequestException('请完整选择预约区域、座位、日期与时间段');
    }
    const startTime = body.startTime || '08:30';
    const endTime = body.endTime || '22:00';
    if (this.icspService.timeToMinutes(endTime) <= this.icspService.timeToMinutes(startTime)) {
      throw new BadRequestException('结束时间必须晚于开始时间');
    }

    const res = await this.icspService.reserveSeat(req.user!, {
      areaId: body.areaId,
      devId: String(body.devId),
      seatName: body.seatName,
      targetDate: body.targetDate,
      startTime,
      endTime,
      source: 'manual',
    });

    if (!res.success) {
      throw new BadRequestException(res.message);
    }

    return res;
  }

  @UseGuards(AuthGuard)
  @Get('reservations/mine')
  getMyReservations(@Req() req: AuthenticatedRequest) {
    const rows = this.dbService.db
      .prepare(
        `SELECT * FROM reservations WHERE user_id = ? ORDER BY id DESC LIMIT 60`,
      )
      .all(req.user!.id) as unknown as ReservationRow[];

    return {
      reservations: rows.map((r) => ({
        id: r.id,
        areaId: r.area_id,
        areaName: r.area_name,
        devId: r.dev_id,
        seatName: r.seat_name,
        targetDate: r.target_date,
        startTime: r.start_time,
        endTime: r.end_time,
        source: r.source,
        status: r.status,
        message: r.message,
        createdAt: r.created_at,
      })),
    };
  }

  @UseGuards(AuthGuard)
  @Get('schedules')
  getSchedules(@Req() req: AuthenticatedRequest) {
    return {
      countdown: this.schedulerService.getNextReleaseCountdown(),
      tasks: this.schedulerService.listUserTasks(req.user!.id),
    };
  }

  @UseGuards(AuthGuard)
  @Post('schedules')
  createSchedule(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateScheduleDto,
  ) {
    return {
      success: true,
      task: this.schedulerService.createTask(req.user!, dto),
    };
  }

  @UseGuards(AuthGuard)
  @Patch('schedules/:id')
  updateSchedule(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: Partial<CreateScheduleDto>,
  ) {
    return {
      success: true,
      task: this.schedulerService.updateTask(req.user!.id, id, dto),
    };
  }

  @UseGuards(AuthGuard)
  @Delete('schedules/:id')
  deleteSchedule(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.schedulerService.deleteTask(req.user!.id, id);
  }

  @UseGuards(AuthGuard)
  @Post('schedules/:id/trigger')
  async triggerSchedule(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() body?: { targetDate?: string },
  ) {
    const task = await this.schedulerService.triggerTaskNow(
      req.user!,
      id,
      body?.targetDate,
    );
    return { success: true, task };
  }

  @UseGuards(AuthGuard)
  @Post('schedules/:id/stop')
  stopSchedule(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    const task = this.schedulerService.stopPolling(req.user!.id, id);
    return { success: true, task };
  }

  @UseGuards(AuthGuard)
  @Get('schedules/:id/logs')
  getScheduleLogs(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return {
      logs: this.schedulerService.getTaskLogs(req.user!.id, id),
    };
  }
}
