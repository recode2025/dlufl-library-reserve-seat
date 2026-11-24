import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  DatabaseService,
  ScheduledTaskRow,
  TaskLogRow,
  UserRow,
} from '../database/database.service';
import { IcspService } from './icspace.service';
import { CasService } from '../auth/cas.service';

export interface CreateScheduleDto {
  name: string;
  areaIds: string[];
  preferredSeats?: number[];
  seatMin?: number;
  seatMax?: number;
  startTime: string;
  endTime: string;
  minFreeRate?: number;
  forceFullRange?: boolean;
  triggerTime?: string; // 默认 '18:01'
  targetDayOffset?: number; // 默认 1（次日座位）
  weekdays?: number[]; // 0=周日..6=周六
  isRecurring?: boolean;
  pollIntervalSec?: number; // 默认 5 秒
  maxPollMinutes?: number; // 默认 180 分钟，0 表示持续轮询直到约上
  enabled?: boolean;
}

@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly runningLocks = new Set<number>();

  constructor(
    private readonly dbService: DatabaseService,
    private readonly icspService: IcspService,
    private readonly casService: CasService,
  ) {}

  onModuleInit() {
    const pollingCount = (
      this.dbService.db
        .prepare(`SELECT COUNT(*) as cnt FROM scheduled_tasks WHERE status = 'polling' AND enabled = 1`)
        .get() as { cnt: number }
    ).cnt;
    if (pollingCount > 0) {
      this.logger.log(`Resuming ${pollingCount} active polling reservation task(s) from SQLite`);
    }
  }

  formatDateLocal(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  formatHHMM(date: Date): string {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  computeTargetDate(baseDate: Date, offsetDays: number): string {
    const d = new Date(baseDate.getTime());
    d.setDate(d.getDate() + offsetDays);
    return this.formatDateLocal(d);
  }

  /**
   * 计算距离下一次 18:00 放座与 18:01 自动开抢的倒计时信息。
   */
  getNextReleaseCountdown(now = new Date()) {
    const release = new Date(now.getTime());
    release.setHours(18, 0, 0, 0);
    const grab = new Date(now.getTime());
    grab.setHours(18, 1, 0, 0);

    let phase: 'before_release' | 'release_window' | 'after_grab' = 'before_release';
    if (now >= release && now < grab) {
      phase = 'release_window';
    } else if (now >= grab) {
      phase = 'after_grab';
      release.setDate(release.getDate() + 1);
      grab.setDate(grab.getDate() + 1);
    }

    return {
      serverTime: now.toISOString(),
      phase,
      nextReleaseAt: release.toISOString(),
      nextGrabAt: grab.toISOString(),
      secondsToRelease: Math.max(0, Math.floor((release.getTime() - now.getTime()) / 1000)),
      secondsToGrab: Math.max(0, Math.floor((grab.getTime() - now.getTime()) / 1000)),
      targetBookingDate: this.computeTargetDate(grab, 1),
    };
  }

  private appendLog(
    taskId: number,
    level: 'info' | 'warn' | 'success' | 'error',
    message: string,
  ) {
    const now = new Date().toISOString();
    this.dbService.db
      .prepare(`INSERT INTO task_logs (task_id, level, message, created_at) VALUES (?, ?, ?, ?)`)
      .run(taskId, level, message, now);
    // 保留最近 120 条日志防止表膨胀
    this.dbService.db
      .prepare(
        `DELETE FROM task_logs
         WHERE task_id = ? AND id NOT IN (
           SELECT id FROM task_logs WHERE task_id = ? ORDER BY id DESC LIMIT 120
         )`,
      )
      .run(taskId, taskId);
  }

  private serializeTask(row: ScheduledTaskRow) {
    const areaIds = JSON.parse(row.area_ids_json || '[]') as string[];
    const areas = areaIds.map((id) => ({
      id,
      name: this.icspService.getAreaById(id)?.name || id,
    }));
    const recentLogs = this.dbService.db
      .prepare(`SELECT * FROM task_logs WHERE task_id = ? ORDER BY id DESC LIMIT 15`)
      .all(row.id) as unknown as TaskLogRow[];

    return {
      id: row.id,
      name: row.name,
      enabled: Boolean(row.enabled),
      areaIds,
      areas,
      preferredSeats: JSON.parse(row.preferred_seats_json || '[]') as number[],
      seatMin: row.seat_min,
      seatMax: row.seat_max,
      startTime: row.start_time,
      endTime: row.end_time,
      minFreeRate: row.min_free_rate,
      forceFullRange: Boolean(row.force_full_range),
      triggerTime: row.trigger_time,
      targetDayOffset: row.target_day_offset,
      weekdays: JSON.parse(row.weekdays_json || '[]') as number[],
      isRecurring: Boolean(row.is_recurring),
      pollIntervalSec: row.poll_interval_sec,
      maxPollMinutes: row.max_poll_minutes,
      status: row.status,
      activeTargetDate: row.active_target_date,
      lastTriggeredDate: row.last_triggered_date,
      pollStartedAt: row.poll_started_at,
      pollAttempts: row.poll_attempts,
      lastMessage: row.last_message,
      lastSeatName: row.last_seat_name,
      lastRunAt: row.last_run_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      recentLogs,
    };
  }

  listUserTasks(userId: number) {
    const rows = this.dbService.db
      .prepare(`SELECT * FROM scheduled_tasks WHERE user_id = ? ORDER BY id DESC`)
      .all(userId) as unknown as ScheduledTaskRow[];
    return rows.map((r) => this.serializeTask(r));
  }

  getTaskLogs(userId: number, taskId: number) {
    const task = this.dbService.db
      .prepare(`SELECT id FROM scheduled_tasks WHERE id = ? AND user_id = ?`)
      .get(taskId, userId);
    if (!task) throw new NotFoundException('未找到指定的定时预约任务');
    return this.dbService.db
      .prepare(`SELECT * FROM task_logs WHERE task_id = ? ORDER BY id DESC LIMIT 80`)
      .all(taskId) as unknown as TaskLogRow[];
  }

  createTask(user: UserRow, dto: CreateScheduleDto) {
    if (!dto.areaIds || dto.areaIds.length === 0) {
      throw new BadRequestException('请至少选择一个目标预约区域');
    }
    const triggerTime = dto.triggerTime || '18:01';
    if (!/^\d{2}:\d{2}$/.test(triggerTime)) {
      throw new BadRequestException('触发时间格式必须为 HH:mm（例如 18:01）');
    }
    const startTime = dto.startTime || '08:30';
    const endTime = dto.endTime || '22:00';
    if (this.icspService.timeToMinutes(endTime) <= this.icspService.timeToMinutes(startTime)) {
      throw new BadRequestException('结束时间必须晚于开始时间');
    }

    const now = new Date().toISOString();
    const weekdays =
      Array.isArray(dto.weekdays) && dto.weekdays.length > 0
        ? dto.weekdays
        : [0, 1, 2, 3, 4, 5, 6];
    const preferredSeats = (dto.preferredSeats || [])
      .map((n) => Number(n))
      .filter((n) => !Number.isNaN(n) && n > 0);

    const enabled = dto.enabled !== false ? 1 : 0;
    const pollIntervalSec = Math.max(2, Math.min(300, Number(dto.pollIntervalSec || 5)));
    const maxPollMinutes = Math.max(0, Math.min(1440, Number(dto.maxPollMinutes ?? 180)));

    const res = this.dbService.db
      .prepare(
        `INSERT INTO scheduled_tasks (
           user_id, name, enabled, area_ids_json, preferred_seats_json,
           seat_min, seat_max, start_time, end_time, min_free_rate, force_full_range,
           trigger_time, target_day_offset, weekdays_json, is_recurring,
           poll_interval_sec, max_poll_minutes, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        user.id,
        (dto.name || '每日 18:01 自动抢座').trim(),
        enabled,
        JSON.stringify(dto.areaIds),
        JSON.stringify(preferredSeats),
        Math.max(1, Number(dto.seatMin || 1)),
        Math.max(1, Number(dto.seatMax || 200)),
        startTime,
        endTime,
        Math.max(10, Math.min(100, Number(dto.minFreeRate ?? 80))),
        dto.forceFullRange ? 1 : 0,
        triggerTime,
        dto.targetDayOffset === 0 ? 0 : 1,
        JSON.stringify(weekdays),
        dto.isRecurring === false ? 0 : 1,
        pollIntervalSec,
        maxPollMinutes,
        enabled ? 'idle' : 'paused',
        now,
        now,
      );

    const taskId = Number(res.lastInsertRowid);
    this.appendLog(
      taskId,
      'info',
      `已创建定时抢座任务：每天 ${triggerTime} 开抢${dto.targetDayOffset === 0 ? '当日' : '次日'} ${startTime}-${endTime} 座位，无座时每 ${pollIntervalSec} 秒自动轮询直到约上。`,
    );

    const row = this.dbService.db
      .prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`)
      .get(taskId) as unknown as ScheduledTaskRow;
    return this.serializeTask(row);
  }

  updateTask(userId: number, taskId: number, patch: Partial<CreateScheduleDto>) {
    const existing = this.dbService.db
      .prepare(`SELECT * FROM scheduled_tasks WHERE id = ? AND user_id = ?`)
      .get(taskId, userId) as unknown as ScheduledTaskRow | undefined;
    if (!existing) throw new NotFoundException('未找到指定的定时预约任务');

    const now = new Date().toISOString();
    const enabled =
      patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled;
    const nextStatus =
      enabled === 0
        ? 'paused'
        : existing.status === 'paused'
          ? 'idle'
          : existing.status;

    this.dbService.db
      .prepare(
        `UPDATE scheduled_tasks
         SET name = ?, enabled = ?, area_ids_json = ?, preferred_seats_json = ?,
             seat_min = ?, seat_max = ?, start_time = ?, end_time = ?,
             min_free_rate = ?, force_full_range = ?, trigger_time = ?,
             target_day_offset = ?, weekdays_json = ?, is_recurring = ?,
             poll_interval_sec = ?, max_poll_minutes = ?, status = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .run(
        patch.name !== undefined ? patch.name.trim() : existing.name,
        enabled,
        patch.areaIds !== undefined ? JSON.stringify(patch.areaIds) : existing.area_ids_json,
        patch.preferredSeats !== undefined
          ? JSON.stringify(patch.preferredSeats)
          : existing.preferred_seats_json,
        patch.seatMin !== undefined ? Number(patch.seatMin) : existing.seat_min,
        patch.seatMax !== undefined ? Number(patch.seatMax) : existing.seat_max,
        patch.startTime ?? existing.start_time,
        patch.endTime ?? existing.end_time,
        patch.minFreeRate !== undefined ? Number(patch.minFreeRate) : existing.min_free_rate,
        patch.forceFullRange !== undefined
          ? patch.forceFullRange
            ? 1
            : 0
          : existing.force_full_range,
        patch.triggerTime ?? existing.trigger_time,
        patch.targetDayOffset !== undefined
          ? patch.targetDayOffset
          : existing.target_day_offset,
        patch.weekdays !== undefined ? JSON.stringify(patch.weekdays) : existing.weekdays_json,
        patch.isRecurring !== undefined ? (patch.isRecurring ? 1 : 0) : existing.is_recurring,
        patch.pollIntervalSec !== undefined
          ? Math.max(2, Number(patch.pollIntervalSec))
          : existing.poll_interval_sec,
        patch.maxPollMinutes !== undefined
          ? Math.max(0, Number(patch.maxPollMinutes))
          : existing.max_poll_minutes,
        nextStatus,
        now,
        taskId,
        userId,
      );

    const updated = this.dbService.db
      .prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`)
      .get(taskId) as unknown as ScheduledTaskRow;
    return this.serializeTask(updated);
  }

  deleteTask(userId: number, taskId: number) {
    const res = this.dbService.db
      .prepare(`DELETE FROM scheduled_tasks WHERE id = ? AND user_id = ?`)
      .run(taskId, userId);
    if (res.changes === 0) throw new NotFoundException('未找到指定的定时预约任务');
    return { success: true };
  }

  /**
   * 立即手动启动一次抢座（若无空座立即进入持续轮询找座模式）。
   */
  async triggerTaskNow(user: UserRow, taskId: number, customTargetDate?: string) {
    const task = this.dbService.db
      .prepare(`SELECT * FROM scheduled_tasks WHERE id = ? AND user_id = ?`)
      .get(taskId, user.id) as unknown as ScheduledTaskRow | undefined;
    if (!task) throw new NotFoundException('未找到指定的定时预约任务');

    const now = new Date();
    const targetDate =
      customTargetDate || this.computeTargetDate(now, task.target_day_offset);
    const nowIso = now.toISOString();

    this.dbService.db
      .prepare(
        `UPDATE scheduled_tasks
         SET enabled = 1, status = 'polling', active_target_date = ?,
             poll_started_at = ?, poll_attempts = 0, last_message = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(targetDate, nowIso, `手动触发抢座，目标日期 ${targetDate}`, nowIso, taskId);

    this.appendLog(taskId, 'info', `用户手动触发抢座（目标日期 ${targetDate}），立即执行寻座...`);

    const freshTask = this.dbService.db
      .prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`)
      .get(taskId) as unknown as ScheduledTaskRow;
    await this.executePollingAttempt(freshTask, true);

    const latest = this.dbService.db
      .prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`)
      .get(taskId) as unknown as ScheduledTaskRow;
    return this.serializeTask(latest);
  }

  stopPolling(userId: number, taskId: number) {
    const task = this.dbService.db
      .prepare(`SELECT * FROM scheduled_tasks WHERE id = ? AND user_id = ?`)
      .get(taskId, userId) as unknown as ScheduledTaskRow | undefined;
    if (!task) throw new NotFoundException('未找到指定的定时预约任务');

    const now = new Date().toISOString();
    this.dbService.db
      .prepare(
        `UPDATE scheduled_tasks
         SET status = 'idle', last_message = '已手动停止本轮轮询，等待下次定时触发', updated_at = ?
         WHERE id = ?`,
      )
      .run(now, taskId);
    this.appendLog(taskId, 'warn', '用户已手动停止本轮轮询找座。');

    const updated = this.dbService.db
      .prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`)
      .get(taskId) as unknown as ScheduledTaskRow;
    return this.serializeTask(updated);
  }

  /**
   * 每秒调度心脏：
   * 1) 精准触发到达 trigger_time（默认 18:01）的定时预约任务 -> 进入 polling 状态
   * 2) 持续驱动处于 polling 状态的任务，按 poll_interval_sec 轮询找座直到成功约上！
   */
  @Interval(1000)
  async tickScheduler() {
    await this.processScheduledTick(new Date());
  }

  async processScheduledTick(now: Date) {
    const todayStr = this.formatDateLocal(now);
    const currentHHMM = this.formatHHMM(now);
    const weekday = now.getDay();

    const enabledTasks = this.dbService.db
      .prepare(`SELECT * FROM scheduled_tasks WHERE enabled = 1`)
      .all() as unknown as ScheduledTaskRow[];

    for (const task of enabledTasks) {
      if (this.runningLocks.has(task.id)) continue;

      // 1) 检查是否命中 18:01（或用户自定义时间）开抢窗口
      if (
        task.status !== 'polling' &&
        task.trigger_time === currentHHMM &&
        task.last_triggered_date !== todayStr
      ) {
        const weekdays = JSON.parse(task.weekdays_json || '[]') as number[];
        const weekdayMatch = weekdays.length === 0 || weekdays.includes(weekday);
        if (weekdayMatch) {
          const targetDate = this.computeTargetDate(now, task.target_day_offset);
          const nowIso = now.toISOString();
          this.dbService.db
            .prepare(
              `UPDATE scheduled_tasks
               SET status = 'polling', active_target_date = ?, last_triggered_date = ?,
                   poll_started_at = ?, poll_attempts = 0,
                   last_message = ?, updated_at = ?
               WHERE id = ?`,
            )
            .run(
              targetDate,
              todayStr,
              nowIso,
              `${currentHHMM} 准时开抢（目标 ${targetDate}），正在寻座...`,
              nowIso,
              task.id,
            );
          this.appendLog(
            task.id,
            'info',
            `${currentHHMM} 定时开抢触发，目标日期 ${targetDate}，开始抢占心仪座位...`,
          );

          const fresh = this.dbService.db
            .prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`)
            .get(task.id) as unknown as ScheduledTaskRow;
          void this.executePollingAttempt(fresh, true);
          continue;
        }
      }

      // 2) 检查正在轮询中的任务是否到达下一次轮询间隔
      if (task.status === 'polling') {
        const lastRunMs = task.last_run_at ? new Date(task.last_run_at).getTime() : 0;
        const elapsedSec = (now.getTime() - lastRunMs) / 1000;
        if (elapsedSec >= Math.max(2, task.poll_interval_sec)) {
          void this.executePollingAttempt(task, false);
        }
      }
    }
  }

  async executePollingAttempt(task: ScheduledTaskRow, isFirstBurst: boolean) {
    if (this.runningLocks.has(task.id)) return;
    this.runningLocks.add(task.id);

    try {
      const now = new Date();
      const nowIso = now.toISOString();
      const user = this.casService.findUserById(task.user_id);
      if (!user) {
        this.markTaskFailed(task.id, '关联用户不存在，任务已停止');
        return;
      }

      // 检查是否超过最大轮询时长（max_poll_minutes === 0 表示持续轮询直到约上）
      if (task.max_poll_minutes > 0 && task.poll_started_at) {
        const elapsedMin =
          (now.getTime() - new Date(task.poll_started_at).getTime()) / (1000 * 60);
        if (elapsedMin >= task.max_poll_minutes) {
          const msg = `已轮询 ${Math.round(elapsedMin)} 分钟（共尝试 ${task.poll_attempts} 次）仍未出现空位，本轮轮询结束，等待下次定时触发。`;
          this.dbService.db
            .prepare(
              `UPDATE scheduled_tasks SET status = 'idle', last_message = ?, updated_at = ? WHERE id = ?`,
            )
            .run(msg, nowIso, task.id);
          this.appendLog(task.id, 'warn', msg);
          return;
        }
      }

      const targetDate =
        task.active_target_date || this.computeTargetDate(now, task.target_day_offset);
      const attemptNum = task.poll_attempts + 1;

      const areaIds = JSON.parse(task.area_ids_json || '[]') as string[];
      const preferredSeats = JSON.parse(task.preferred_seats_json || '[]') as number[];

      const candidate = await this.icspService.findBestSeatCandidate(user, {
        areaIds,
        targetDate,
        startTime: task.start_time,
        endTime: task.end_time,
        preferredSeats,
        seatMin: task.seat_min,
        seatMax: task.seat_max,
        minFreeRate: task.min_free_rate,
        forceFullRange: Boolean(task.force_full_range),
      });

      if (!candidate) {
        const msg = `第 ${attemptNum} 次寻座未发现满足条件的空闲座位（空闲率 ≥ ${task.min_free_rate}%），${task.poll_interval_sec} 秒后继续轮询...`;
        this.dbService.db
          .prepare(
            `UPDATE scheduled_tasks
             SET poll_attempts = ?, last_run_at = ?, last_message = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(attemptNum, nowIso, msg, nowIso, task.id);

        if (attemptNum <= 3 || attemptNum % 10 === 0) {
          this.appendLog(task.id, 'info', msg);
        }
        return;
      }

      const reserveRes = await this.icspService.reserveSeat(user, {
        areaId: candidate.seat.areaId,
        devId: candidate.seat.devId,
        seatName: candidate.seat.devName,
        targetDate,
        startTime: candidate.slot.startStr,
        endTime: candidate.slot.endStr,
        source: isFirstBurst && attemptNum === 1 ? 'scheduled' : 'polling',
        scheduleId: task.id,
      });

      if (reserveRes.success) {
        const nextEnabled = task.is_recurring ? 1 : 0;
        const msg = `第 ${attemptNum} 次尝试成功抢到 ${candidate.seat.areaName} ${candidate.seat.devName}（${targetDate} ${candidate.slot.startStr}-${candidate.slot.endStr}）`;
        this.dbService.db
          .prepare(
            `UPDATE scheduled_tasks
             SET status = 'succeeded', enabled = ?, poll_attempts = ?, last_run_at = ?,
                 last_seat_name = ?, last_message = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            nextEnabled,
            attemptNum,
            nowIso,
            `${candidate.seat.areaName} ${candidate.seat.devName}`,
            msg,
            nowIso,
            task.id,
          );
        this.appendLog(task.id, 'success', msg);
        this.logger.log(`Task #${task.id} succeeded: ${msg}`);
      } else {
        const msg = `第 ${attemptNum} 次尝试预约 ${candidate.seat.devName} 未成功（${reserveRes.message}），继续轮询下一个空位...`;
        this.dbService.db
          .prepare(
            `UPDATE scheduled_tasks
             SET poll_attempts = ?, last_run_at = ?, last_message = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(attemptNum, nowIso, msg, nowIso, task.id);
        this.appendLog(task.id, 'warn', msg);
      }
    } catch (e: any) {
      const nowIso = new Date().toISOString();
      const errMsg = `轮询异常: ${e?.message || '未知错误'}，将在下个周期重试`;
      this.dbService.db
        .prepare(
          `UPDATE scheduled_tasks
           SET poll_attempts = poll_attempts + 1, last_run_at = ?, last_message = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(nowIso, errMsg, nowIso, task.id);
      this.appendLog(task.id, 'error', errMsg);
    } finally {
      this.runningLocks.delete(task.id);
    }
  }

  private markTaskFailed(taskId: number, reason: string) {
    const nowIso = new Date().toISOString();
    this.dbService.db
      .prepare(
        `UPDATE scheduled_tasks SET status = 'failed', enabled = 0, last_message = ?, updated_at = ? WHERE id = ?`,
      )
      .run(reason, nowIso, taskId);
    this.appendLog(taskId, 'error', reason);
  }
}
