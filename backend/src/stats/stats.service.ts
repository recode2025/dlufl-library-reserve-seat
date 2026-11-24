import { Injectable } from '@nestjs/common';
import { DatabaseService, ReservationRow, UserRow } from '../database/database.service';
import { hashVisitor } from '../common/crypto.util';
import { appConfig, LIBRARY_AREAS } from '../config/app.config';
import { SchedulerService } from '../library/scheduler.service';

@Injectable()
export class StatsService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly schedulerService: SchedulerService,
  ) {}

  private maskName(name: string): string {
    const trimmed = (name || '').trim();
    if (!trimmed) return '*';
    if (trimmed.length === 1) return '*';
    if (trimmed.length === 2) return `${trimmed[0]}*`;
    const maskIdx = Math.floor(trimmed.length / 2);
    return `${trimmed.slice(0, maskIdx)}*${trimmed.slice(maskIdx + 1)}`;
  }

  private computeCardTier(totalSuccess: number): { code: string; label: string; nextTarget: number } {
    if (totalSuccess >= 30) return { code: 'scholar', label: '馆藏常驻学者', nextTarget: 50 };
    if (totalSuccess >= 10) return { code: 'star', label: '研修之星', nextTarget: 30 };
    if (totalSuccess >= 1) return { code: 'regular', label: '勤学常客', nextTarget: 10 };
    return { code: 'newcomer', label: '初遇书海', nextTarget: 1 };
  }

  recordVisit(ip: string, userAgent: string, visitPath = '/') {
    const now = new Date();
    const visitDate = this.schedulerService.formatDateLocal(now);
    const visitorHash = hashVisitor(`${ip}|${userAgent}`);

    this.dbService.db
      .prepare(
        `INSERT INTO visit_logs (visitor_hash, path, visit_date, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(visitorHash, visitPath.slice(0, 120), visitDate, now.toISOString());

    const totalVisits = this.dbService.incrementMetric('total_visits', 1);
    const todayVisits = (
      this.dbService.db
        .prepare(`SELECT COUNT(*) as cnt FROM visit_logs WHERE visit_date = ?`)
        .get(visitDate) as { cnt: number }
    ).cnt;

    const totalSuccessfulBookings = this.getTotalSuccessfulBookings();
    return {
      totalVisits,
      todayVisits,
      totalSuccessfulBookings,
    };
  }

  getTotalSuccessfulBookings(): number {
    const dbCount = (
      this.dbService.db
        .prepare(`SELECT COUNT(*) as cnt FROM reservations WHERE status = 'success'`)
        .get() as { cnt: number }
    ).cnt;
    const metricCount = this.dbService.getMetric('total_successful_bookings');
    return Math.max(dbCount, metricCount);
  }

  getOverview(currentUser?: UserRow) {
    const now = new Date();
    const today = this.schedulerService.formatDateLocal(now);

    const totalVisits = this.dbService.getMetric('total_visits');
    const todayVisits = (
      this.dbService.db
        .prepare(`SELECT COUNT(*) as cnt FROM visit_logs WHERE visit_date = ?`)
        .get(today) as { cnt: number }
    ).cnt;

    const totalSuccessfulBookings = this.getTotalSuccessfulBookings();
    const todaySuccessfulBookings = (
      this.dbService.db
        .prepare(
          `SELECT COUNT(*) as cnt FROM reservations
           WHERE status = 'success' AND substr(created_at, 1, 10) = ?`,
        )
        .get(today) as { cnt: number }
    ).cnt;

    const activePollingTasks = (
      this.dbService.db
        .prepare(
          `SELECT COUNT(*) as cnt FROM scheduled_tasks WHERE enabled = 1 AND status = 'polling'`,
        )
        .get() as { cnt: number }
    ).cnt;

    const activeSchedules = (
      this.dbService.db
        .prepare(`SELECT COUNT(*) as cnt FROM scheduled_tasks WHERE enabled = 1`)
        .get() as { cnt: number }
    ).cnt;

    // 仅统计当前有效绑定 ICSpace 的真实去重师生账号（解绑后实时扣减，重新绑定同一学号不重复累加）
    const demoFilter = appConfig.mockMode ? '' : `AND cas_user_id NOT LIKE 'demo_%'`;
    const registeredUsers = (
      this.dbService.db
        .prepare(
          `SELECT COUNT(DISTINCT student_id) as cnt FROM users WHERE icspace_bound = 1 ${demoFilter}`,
        )
        .get() as { cnt: number }
    ).cnt;

    const totalCasUsers = (
      this.dbService.db
        .prepare(`SELECT COUNT(DISTINCT student_id) as cnt FROM users WHERE 1=1 ${demoFilter}`)
        .get() as { cnt: number }
    ).cnt;

    const areaRows = this.dbService.db
      .prepare(
        `SELECT area_id, area_name, COUNT(*) as count
         FROM reservations
         WHERE status = 'success'
         GROUP BY area_id, area_name
         ORDER BY count DESC`,
      )
      .all() as Array<{ area_id: string; area_name: string; count: number }>;

    const areaMap = new Map(areaRows.map((r) => [r.area_id, r.count]));
    const areaDistribution = LIBRARY_AREAS.map((a) => ({
      areaId: a.id,
      areaName: a.name,
      floor: a.floor,
      successCount: areaMap.get(a.id) || 0,
    }));

    const recentRows = this.dbService.db
      .prepare(
        `SELECT * FROM reservations
         WHERE status = 'success'
         ORDER BY id DESC
         LIMIT 10`,
      )
      .all() as unknown as ReservationRow[];

    const recentSuccesses = recentRows.map((r) => ({
      id: r.id,
      studentName: this.maskName(r.student_name),
      unitName: r.unit_name,
      areaName: r.area_name,
      seatName: r.seat_name,
      targetDate: r.target_date,
      startTime: r.start_time,
      endTime: r.end_time,
      source: r.source,
      createdAt: r.created_at,
    }));

    return {
      totalSuccessfulBookings,
      todaySuccessfulBookings,
      totalVisits,
      todayVisits,
      activePollingTasks,
      activeSchedules,
      registeredUsers,
      totalCasUsers,
      countdown: this.schedulerService.getNextReleaseCountdown(now),
      areaDistribution,
      recentSuccesses,
    };
  }

  /**
   * 卡片系统：按学号/一卡通号或姓名查询个人成功预约次数与统计凭证卡片。
   */
  queryReservationCard(query: string, currentUser?: UserRow) {
    const q = (query || '').trim();
    let targetUser: UserRow | undefined;

    if (!q && currentUser) {
      targetUser = currentUser;
    } else if (q) {
      targetUser = this.dbService.db
        .prepare(
          `SELECT * FROM users
           WHERE student_id = ? OR name = ? OR student_id LIKE ? OR name LIKE ?
           ORDER BY CASE WHEN student_id = ? THEN 0 WHEN name = ? THEN 1 ELSE 2 END, id ASC
           LIMIT 1`,
        )
        .get(q, q, `${q}%`, `%${q}%`, q, q) as UserRow | undefined;
    }

    if (!targetUser) {
      // 回退检查 reservations 表（兼容直接导入的历史记录）
      const fallbackRow = q
        ? (this.dbService.db
            .prepare(
              `SELECT student_id, student_name, unit_name FROM reservations
               WHERE student_id = ? OR student_name LIKE ?
               ORDER BY id DESC LIMIT 1`,
            )
            .get(q, `%${q}%`) as
            | { student_id: string; student_name: string; unit_name: string }
            | undefined)
        : undefined;

      if (!fallbackRow) {
        return {
          found: false,
          query: q,
          message: q
            ? `未查询到与「${q}」匹配的校园一卡通/学号预约记录`
            : '请先登录或输入学号/姓名查询成功预约次数卡片',
          card: null,
        };
      }

      return {
        found: true,
        query: q,
        card: this.buildCardForStudent(
          fallbackRow.student_id,
          fallbackRow.student_name,
          fallbackRow.unit_name,
          currentUser?.student_id === fallbackRow.student_id,
        ),
      };
    }

    const isSelf = Boolean(currentUser && currentUser.id === targetUser.id);
    return {
      found: true,
      query: q || targetUser.student_id,
      card: this.buildCardForStudent(
        targetUser.student_id,
        targetUser.name,
        targetUser.unit_name,
        isSelf,
      ),
    };
  }

  private buildCardForStudent(
    studentId: string,
    studentName: string,
    unitName: string,
    isSelf: boolean,
  ) {
    const allRows = this.dbService.db
      .prepare(`SELECT * FROM reservations WHERE student_id = ? ORDER BY id DESC`)
      .all(studentId) as unknown as ReservationRow[];

    const successRows = allRows.filter((r) => r.status === 'success');
    const now = new Date();
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    let thisMonthSuccess = 0;
    let thisWeekSuccess = 0;
    let manualSuccess = 0;
    let scheduledSuccess = 0;
    let pollingSuccess = 0;

    const areaCounter = new Map<string, { areaId: string; areaName: string; count: number }>();
    const activeDates = new Set<string>();

    for (const r of successRows) {
      if (r.created_at.startsWith(monthPrefix) || r.target_date.startsWith(monthPrefix)) {
        thisMonthSuccess++;
      }
      if (r.created_at >= weekAgo) {
        thisWeekSuccess++;
      }
      if (r.source === 'manual') manualSuccess++;
      else if (r.source === 'scheduled') scheduledSuccess++;
      else if (r.source === 'polling') pollingSuccess++;

      activeDates.add(r.target_date);
      const curr = areaCounter.get(r.area_id) || {
        areaId: r.area_id,
        areaName: r.area_name,
        count: 0,
      };
      curr.count++;
      areaCounter.set(r.area_id, curr);
    }

    const areaBreakdown = Array.from(areaCounter.values()).sort((a, b) => b.count - a.count);
    const favoriteArea = areaBreakdown[0]?.areaName || '暂无偏好区域';
    const totalAttempts = allRows.length;
    const successRate =
      totalAttempts > 0 ? Math.round((successRows.length / totalAttempts) * 100) : 100;

    const tier = this.computeCardTier(successRows.length);

    return {
      studentId,
      name: isSelf ? studentName : this.maskName(studentName),
      fullNameVisible: isSelf,
      unitName,
      cardTier: tier,
      totalSuccess: successRows.length,
      thisMonthSuccess,
      thisWeekSuccess,
      manualSuccess,
      scheduledSuccess,
      pollingSuccess,
      totalAttempts,
      successRate,
      favoriteArea,
      activeDays: activeDates.size,
      lastSuccessAt: successRows[0]?.created_at || null,
      areaBreakdown,
      recentRecords: successRows.slice(0, 12).map((r) => ({
        id: r.id,
        areaId: r.area_id,
        areaName: r.area_name,
        seatName: r.seat_name,
        targetDate: r.target_date,
        startTime: r.start_time,
        endTime: r.end_time,
        source: r.source,
        createdAt: r.created_at,
      })),
    };
  }

  getCardLeaderboard(currentUser?: UserRow) {
    const rows = this.dbService.db
      .prepare(
        `SELECT
           student_id,
           MAX(student_name) as student_name,
           MAX(unit_name) as unit_name,
           COUNT(*) as total_success,
           SUM(CASE WHEN source IN ('scheduled', 'polling') THEN 1 ELSE 0 END) as auto_success,
           MAX(area_name) as last_area,
           MAX(seat_name) as last_seat,
           MAX(created_at) as last_success_at
         FROM reservations
         WHERE status = 'success'
         GROUP BY student_id
         ORDER BY total_success DESC, last_success_at DESC
         LIMIT 12`,
      )
      .all() as Array<{
      student_id: string;
      student_name: string;
      unit_name: string;
      total_success: number;
      auto_success: number;
      last_area: string;
      last_seat: string;
      last_success_at: string;
    }>;

    return rows.map((r, idx) => {
      const isSelf = Boolean(currentUser && currentUser.student_id === r.student_id);
      const maskedSid =
        isSelf || r.student_id.length <= 4
          ? r.student_id
          : `${r.student_id.slice(0, 4)}****${r.student_id.slice(-2)}`;
      return {
        rank: idx + 1,
        studentId: isSelf ? r.student_id : maskedSid,
        rawQueryKey: r.student_id,
        name: isSelf ? r.student_name : this.maskName(r.student_name),
        unitName: r.unit_name,
        totalSuccess: r.total_success,
        autoSuccess: r.auto_success,
        lastArea: r.last_area,
        lastSeat: r.last_seat,
        lastSuccessAt: r.last_success_at,
        tier: this.computeCardTier(r.total_success),
      };
    });
  }
}
