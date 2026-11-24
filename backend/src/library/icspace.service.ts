import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { Cookie, CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import * as cheerio from 'cheerio';
import { strEnc } from '../auth/des';
import { appConfig, LIBRARY_AREAS, LibraryAreaConfig } from '../config/app.config';
import { decryptSecret, encryptSecret } from '../common/crypto.util';
import { DatabaseService, UserRow } from '../database/database.service';

export interface TimeSlot {
  start: number; // minutes from 00:00
  end: number;
  startStr: string;
  endStr: string;
  durationMin: number;
}

export interface SeatInfo {
  devId: string;
  devName: string;
  seatNumber: number;
  areaId: string;
  areaName: string;
  status: 'free' | 'partial' | 'occupied';
  freeRate: number;
  longestFreeSlot: TimeSlot | null;
  freeSlots: TimeSlot[];
  busySlots: TimeSlot[];
}

export interface CachedIcspaceSession {
  cookies: Record<string, string>;
  accNo: string;
  token: string;
  trueName: string;
  pid: string;
  updatedAt: number;
}

export interface ReserveSeatResult {
  success: boolean;
  message: string;
  remoteResvId?: string;
  reservationId?: number;
}

@Injectable()
export class IcspService {
  private readonly logger = new Logger(IcspService.name);
  private readonly sessionCache = new Map<number, CachedIcspaceSession>();

  constructor(private readonly dbService: DatabaseService) {}

  getAreas(): LibraryAreaConfig[] {
    return LIBRARY_AREAS;
  }

  getAreaById(areaId: string): LibraryAreaConfig | undefined {
    return LIBRARY_AREAS.find((a) => a.id === areaId);
  }

  private buildHeaders() {
    return {
      'User-Agent': `${appConfig.cas.userAgent} ${Date.now()}`,
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Content-Type': 'application/x-www-form-urlencoded',
      Pragma: 'no-cache',
      'Upgrade-Insecure-Requests': '1',
    };
  }

  timeToMinutes(timeStr: string): number {
    const [h, m] = timeStr.split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return 0;
    return h * 60 + m;
  }

  minutesToTime(minutes: number): string {
    const clamped = Math.max(0, Math.min(24 * 60, Math.round(minutes)));
    const h = Math.floor(clamped / 60);
    const m = clamped % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  private timestampToMinutes(ts: number): number {
    const d = new Date(ts);
    return d.getHours() * 60 + d.getMinutes();
  }

  private createClientFromCookies(cookies: Record<string, string>): AxiosInstance {
    const jar = new CookieJar();
    for (const [key, value] of Object.entries(cookies)) {
      if (value) {
        jar.setCookieSync(new Cookie({ key, value }), appConfig.icspace.host);
      }
    }
    return wrapper(
      axios.create({
        jar,
        headers: this.buildHeaders(),
        timeout: 15000,
      }),
    );
  }

  private async getIcspaceServiceCallbackUrl(): Promise<string> {
    const host = appConfig.icspace.host;
    const apiUrl = `${host}/ic-web/auth/address?finalAddress=${encodeURIComponent(host)}&errPageUrl=${encodeURIComponent(`${host}/#/error`)}&manager=false&consoleType=16`;
    const response = await axios.get(apiUrl, { timeout: 15000 });
    const loginUrl = response.data?.data;
    if (!loginUrl) {
      throw new Error('未能从 ICSpace 获取登录跳转地址');
    }

    const loginResponse = await axios.get(loginUrl, {
      validateStatus: (status) => status >= 200 && status < 400,
      maxRedirects: 0,
      timeout: 15000,
    });

    const location = loginResponse.headers['location'];
    if (!location) {
      throw new Error('ICSpace 认证地址未返回 CAS 重定向 Location');
    }

    const parsedUrl = new URL(location);
    const service = parsedUrl.searchParams.get('service');
    if (!service) {
      throw new Error('ICSpace 重定向 URL 中缺少 service 参数');
    }
    return service;
  }

  /**
   * 通过 DLUFL CAS 换取 ICSpace 会话 Cookie（JSESSIONID + ic-cookie）以及 accNo / token。
   * 协议严格对齐 workspace 原有 src/cas/index.ts 与 src/icspace/index.ts。
   */
  async authenticateIcspace(
    studentId: string,
    password: string,
  ): Promise<CachedIcspaceSession> {
    if (appConfig.mockMode) {
      return {
        cookies: {
          JSESSIONID: `mock_jsession_${studentId}`,
          'ic-cookie': `mock_ic_${studentId}`,
        },
        accNo: studentId,
        token: `mock_token_${studentId}`,
        trueName: studentId,
        pid: studentId,
        updatedAt: Date.now(),
      };
    }

    const serviceUrl = await this.getIcspaceServiceCallbackUrl();
    const casHost = appConfig.cas.serverUrl;
    const jar = new CookieJar();
    const client = wrapper(
      axios.create({
        jar,
        headers: this.buildHeaders(),
        timeout: 15000,
      }),
    );

    const initResponse = await client.get(
      `${casHost}${appConfig.cas.loginPath}?service=${encodeURIComponent(serviceUrl)}&renew=true&_=${Date.now()}`,
    );
    const $ = cheerio.load(initResponse.data);
    const ticket = String($('#lt').val() || '');
    const execution = String($('input[name="execution"]').val() || '');
    if (!ticket || !execution) {
      throw new Error('无法从大外 CAS 登录页获取 lt / execution');
    }

    const rsa = strEnc(`${studentId.trim()}${password.trim()}${ticket}`, '1', '2', '3');
    await client.post(
      `${casHost}${appConfig.cas.loginPath}?service=${encodeURIComponent(serviceUrl)}`,
      new URLSearchParams({
        rsa,
        ul: String(studentId.trim().length),
        pl: String(password.trim().length),
        lt: ticket,
        execution,
        _eventId: 'submit',
      }).toString(),
    );

    const cookiesList = await jar.getCookies(appConfig.icspace.host);
    const cookies: Record<string, string> = {};
    for (const key of ['JSESSIONID', 'ic-cookie']) {
      const found = cookiesList.find((c) => c.key === key)?.value;
      if (found) cookies[key] = found;
    }
    if (!cookies['JSESSIONID'] || !cookies['ic-cookie']) {
      throw new Error('大外统一身份认证失败，请检查密码是否正确或校园网是否连通');
    }

    const icClient = this.createClientFromCookies(cookies);
    const userInfoResp = await icClient.get(`${appConfig.icspace.host}/ic-web/auth/userInfo`);
    if (userInfoResp.data?.code !== 0 || !userInfoResp.data?.data) {
      throw new Error(userInfoResp.data?.message || '获取 ICSpace 用户信息失败');
    }

    const info = userInfoResp.data.data;
    return {
      cookies,
      accNo: String(info.accNo),
      token: String(info.token || ''),
      trueName: String(info.trueName || ''),
      pid: String(info.pid || studentId),
      updatedAt: Date.now(),
    };
  }

  async bindUserCredentials(user: UserRow, password: string) {
    let session: CachedIcspaceSession;
    try {
      session = await this.authenticateIcspace(user.student_id, password);
    } catch (e: any) {
      throw new BadRequestException(e?.message || '图书馆身份校验失败');
    }

    const now = new Date().toISOString();
    const encPwd = encryptSecret(password);
    const encSession = encryptSecret(JSON.stringify(session));

    this.dbService.db
      .prepare(
        `UPDATE users
         SET encrypted_cas_password = ?, icspace_cookies_json = ?, icspace_bound = 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(encPwd, encSession, now, user.id);

    this.sessionCache.set(user.id, session);
    return {
      accNo: session.accNo,
      trueName: session.trueName || user.name,
      pid: session.pid || user.student_id,
    };
  }

  markMockBound(userId: number) {
    const now = new Date().toISOString();
    this.dbService.db
      .prepare(`UPDATE users SET icspace_bound = 1, updated_at = ? WHERE id = ?`)
      .run(now, userId);
  }

  unbindUserCredentials(userId: number) {
    const now = new Date().toISOString();
    this.dbService.db
      .prepare(
        `UPDATE users
         SET encrypted_cas_password = NULL, icspace_cookies_json = NULL, icspace_bound = 0, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, userId);
    this.sessionCache.delete(userId);
  }

  private async ensureUserSession(
    user: UserRow,
    forceRefresh = false,
  ): Promise<CachedIcspaceSession> {
    if (appConfig.mockMode) {
      return {
        cookies: { JSESSIONID: 'mock', 'ic-cookie': 'mock' },
        accNo: user.student_id,
        token: 'mock-token',
        trueName: user.name,
        pid: user.student_id,
        updatedAt: Date.now(),
      };
    }

    const cached = this.sessionCache.get(user.id);
    // 25 分钟内直接复用内存缓存，避免高频重复登录 CAS
    if (!forceRefresh && cached && Date.now() - cached.updatedAt < 25 * 60 * 1000) {
      return cached;
    }

    if (!forceRefresh && user.icspace_cookies_json) {
      try {
        const parsed = JSON.parse(decryptSecret(user.icspace_cookies_json)) as CachedIcspaceSession;
        if (Date.now() - parsed.updatedAt < 25 * 60 * 1000) {
          this.sessionCache.set(user.id, parsed);
          return parsed;
        }
      } catch {
        // ignore corrupted cache and refresh
      }
    }

    if (!user.encrypted_cas_password) {
      throw new BadRequestException(
        '尚未完成图书馆预约凭证授权，请先在右上角或预约授权弹窗中绑定大外统一身份密码',
      );
    }

    const plainPwd = decryptSecret(user.encrypted_cas_password);
    const fresh = await this.authenticateIcspace(user.student_id, plainPwd);
    const now = new Date().toISOString();
    this.dbService.db
      .prepare(`UPDATE users SET icspace_cookies_json = ?, updated_at = ? WHERE id = ?`)
      .run(encryptSecret(JSON.stringify(fresh)), now, user.id);
    this.sessionCache.set(user.id, fresh);
    return fresh;
  }

  private computeSeatIntervals(
    rawResvInfo: Array<{ start: number; end: number }>,
    startMinutes: number,
    endMinutes: number,
  ): { busySlots: TimeSlot[]; freeSlots: TimeSlot[]; longestFreeSlot: TimeSlot | null; freeRate: number } {
    const busySlots: TimeSlot[] = [];
    const sorted = [...(rawResvInfo || [])].sort((a, b) => a.start - b.start);

    const freeSlots: TimeSlot[] = [];
    let lastEnd = startMinutes;

    for (const item of sorted) {
      const s = item.start > 2000 ? this.timestampToMinutes(item.start) : item.start;
      const e = item.end > 2000 ? this.timestampToMinutes(item.end) : item.end;
      if (e <= s) continue;

      busySlots.push({
        start: s,
        end: e,
        startStr: this.minutesToTime(s),
        endStr: this.minutesToTime(e),
        durationMin: e - s,
      });

      if (s > lastEnd && s <= endMinutes) {
        const freeStart = Math.max(startMinutes, lastEnd);
        const freeEnd = Math.min(endMinutes, s);
        if (freeEnd > freeStart) {
          freeSlots.push({
            start: freeStart,
            end: freeEnd,
            startStr: this.minutesToTime(freeStart),
            endStr: this.minutesToTime(freeEnd),
            durationMin: freeEnd - freeStart,
          });
        }
      }
      lastEnd = Math.max(lastEnd, e);
    }

    if (lastEnd < endMinutes) {
      const freeStart = Math.max(startMinutes, lastEnd);
      freeSlots.push({
        start: freeStart,
        end: endMinutes,
        startStr: this.minutesToTime(freeStart),
        endStr: this.minutesToTime(endMinutes),
        durationMin: endMinutes - freeStart,
      });
    }

    let longestFreeSlot: TimeSlot | null = null;
    for (const slot of freeSlots) {
      if (!longestFreeSlot || slot.durationMin > longestFreeSlot.durationMin) {
        longestFreeSlot = slot;
      }
    }

    const totalRange = Math.max(1, endMinutes - startMinutes);
    const freeRate = longestFreeSlot
      ? Math.round((longestFreeSlot.durationMin / totalRange) * 100)
      : 0;

    return { busySlots, freeSlots, longestFreeSlot, freeRate };
  }

  private extractSeatNumber(devName: string, fallbackIndex: number): number {
    const parts = devName.split('-');
    const tail = parts[parts.length - 1] || devName;
    const match = tail.match(/\d+/);
    return match ? parseInt(match[0], 10) : fallbackIndex + 1;
  }

  private generateMockSeats(
    area: LibraryAreaConfig,
    targetDate: string,
    startTime: string,
    endTime: string,
  ): SeatInfo[] {
    const startMin = this.timeToMinutes(startTime);
    const endMin = this.timeToMinutes(endTime);

    // 读取本地数据库中该区域该日期已成功预约的记录，真实反映已被占用的座位
    const bookedRows = this.dbService.db
      .prepare(
        `SELECT dev_id, start_time, end_time FROM reservations
         WHERE area_id = ? AND target_date = ? AND status = 'success'`,
      )
      .all(area.id, targetDate) as Array<{
      dev_id: string;
      start_time: string;
      end_time: string;
    }>;

    const bookedMap = new Map<string, Array<{ start: number; end: number }>>();
    for (const row of bookedRows) {
      const list = bookedMap.get(row.dev_id) || [];
      list.push({
        start: this.timeToMinutes(row.start_time),
        end: this.timeToMinutes(row.end_time),
      });
      bookedMap.set(row.dev_id, list);
    }

    const dateSeed = targetDate.split('-').reduce((acc, p) => acc * 31 + Number(p), 7);
    const areaSeed = Number(area.id.slice(-4)) || 101;
    const prefixMap: Record<string, string> = {
      '100475785': '2E',
      '100475787': '2M',
      '100475789': '2W',
      '109342010': '6E',
    };
    const prefix = prefixMap[area.id] || 'LIB';

    const seats: SeatInfo[] = [];
    for (let i = 1; i <= area.defaultSeatCount; i++) {
      const devId = `${area.id}_${String(i).padStart(3, '0')}`;
      const devName = `${prefix}-${String(i).padStart(3, '0')}`;
      const hash = (dateSeed * 17 + areaSeed * 13 + i * 29) % 100;

      const rawBusy: Array<{ start: number; end: number }> = [
        ...(bookedMap.get(devId) || []),
      ];

      if (rawBusy.length === 0) {
        if (hash < 42) {
          // 全天被占
          rawBusy.push({ start: 8 * 60 + 30, end: 22 * 60 });
        } else if (hash < 68) {
          // 上午或下午部分被占
          if (hash % 2 === 0) {
            rawBusy.push({ start: 8 * 60 + 30, end: 13 * 60 + 30 });
          } else {
            rawBusy.push({ start: 14 * 60, end: 19 * 60 });
          }
        }
      }

      const { busySlots, freeSlots, longestFreeSlot, freeRate } =
        this.computeSeatIntervals(rawBusy, startMin, endMin);

      let status: SeatInfo['status'] = 'occupied';
      if (freeRate >= 98) status = 'free';
      else if (longestFreeSlot && longestFreeSlot.durationMin >= 30) status = 'partial';

      seats.push({
        devId,
        devName,
        seatNumber: i,
        areaId: area.id,
        areaName: area.name,
        status,
        freeRate,
        longestFreeSlot,
        freeSlots,
        busySlots,
      });
    }

    return seats;
  }

  async fetchAreaSeats(
    user: UserRow | undefined,
    areaId: string,
    targetDate: string,
    startTime = '08:30',
    endTime = '22:00',
  ): Promise<{
    area: LibraryAreaConfig;
    targetDate: string;
    startTime: string;
    endTime: string;
    isLive: boolean;
    notice?: string;
    summary: { total: number; free: number; partial: number; occupied: number };
    seats: SeatInfo[];
  }> {
    const area = this.getAreaById(areaId);
    if (!area) {
      throw new BadRequestException(`未知的图书馆区域 ID: ${areaId}`);
    }

    if (appConfig.mockMode) {
      const seats = this.generateMockSeats(area, targetDate, startTime, endTime);
      return {
        area,
        targetDate,
        startTime,
        endTime,
        isLive: false,
        notice: '当前处于演练模式（ICSPACE_MOCK_MODE=true），座位状态由本地模拟器与真实预约库联合生成。',
        summary: this.summarizeSeats(seats),
        seats,
      };
    }

    if (!user || !user.icspace_bound) {
      return {
        area,
        targetDate,
        startTime,
        endTime,
        isLive: false,
        notice: '请先登录并完成「图书馆预约凭证授权」，即可实时加载大外 ICSpace 座位占用数据。',
        summary: { total: 0, free: 0, partial: 0, occupied: 0 },
        seats: [],
      };
    }

    const startMin = this.timeToMinutes(startTime);
    const endMin = this.timeToMinutes(endTime);
    const compactDate = targetDate.replace(/-/g, '');
    const apiUrl = `${appConfig.icspace.host}/ic-web/reserve?roomIds=${area.id}&resvDates=${compactDate}&sysKind=8&_=${Date.now()}`;

    let rawList: any[] | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const session = await this.ensureUserSession(user, attempt > 0);
      const client = this.createClientFromCookies(session.cookies);
      const response = await client.get(apiUrl);
      if (response.data?.code === 0 && Array.isArray(response.data?.data)) {
        rawList = response.data.data;
        break;
      }
      // 认证过期自动刷新重登一次
      if (attempt === 0) {
        this.logger.warn(
          `ICSpace seats fetch returned code=${response.data?.code} (${response.data?.message}), refreshing session...`,
        );
        continue;
      }
      throw new BadRequestException(
        `获取图书馆座位失败: ${response.data?.message || 'ICSpace 接口异常'}`,
      );
    }

    const seats: SeatInfo[] = (rawList || []).map((device: any, idx: number) => {
      const devName = String(device.devName || `${area.name}-${idx + 1}`);
      const seatNumber = this.extractSeatNumber(devName, idx);
      const { busySlots, freeSlots, longestFreeSlot, freeRate } =
        this.computeSeatIntervals(device.resvInfo || [], startMin, endMin);

      let status: SeatInfo['status'] = 'occupied';
      if (freeRate >= 98) status = 'free';
      else if (longestFreeSlot && longestFreeSlot.durationMin >= 30) status = 'partial';

      return {
        devId: String(device.devId),
        devName,
        seatNumber,
        areaId: area.id,
        areaName: area.name,
        status,
        freeRate,
        longestFreeSlot,
        freeSlots,
        busySlots,
      };
    });

    seats.sort((a, b) => a.seatNumber - b.seatNumber);

    return {
      area,
      targetDate,
      startTime,
      endTime,
      isLive: true,
      summary: this.summarizeSeats(seats),
      seats,
    };
  }

  private summarizeSeats(seats: SeatInfo[]) {
    let free = 0;
    let partial = 0;
    let occupied = 0;
    for (const s of seats) {
      if (s.status === 'free') free++;
      else if (s.status === 'partial') partial++;
      else occupied++;
    }
    return { total: seats.length, free, partial, occupied };
  }

  async reserveSeat(
    user: UserRow,
    params: {
      areaId: string;
      devId: string;
      seatName: string;
      targetDate: string;
      startTime: string;
      endTime: string;
      source: 'manual' | 'scheduled' | 'polling';
      scheduleId?: number | null;
    },
  ): Promise<ReserveSeatResult> {
    const area = this.getAreaById(params.areaId);
    const areaName = area?.name || params.areaId;

    const startTimeNorm = params.startTime.length === 5 ? `${params.startTime}:00` : params.startTime;
    const endTimeNorm = params.endTime.length === 5 ? `${params.endTime}:00` : params.endTime;

    let success = false;
    let message = '';
    let remoteResvId: string | undefined;

    if (appConfig.mockMode) {
      // 检查是否冲突
      const conflict = this.dbService.db
        .prepare(
          `SELECT id FROM reservations
           WHERE area_id = ? AND dev_id = ? AND target_date = ? AND status = 'success'
             AND NOT (end_time <= ? OR start_time >= ?)
           LIMIT 1`,
        )
        .get(params.areaId, params.devId, params.targetDate, params.startTime, params.endTime);

      if (conflict) {
        success = false;
        message = `座位 ${params.seatName} 在该时间段已被预约`;
      } else {
        success = true;
        remoteResvId = `MOCK-${Date.now()}`;
        message = `成功预约 ${areaName} ${params.seatName} (${params.targetDate} ${params.startTime}-${params.endTime})`;
      }
    } else {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const session = await this.ensureUserSession(user, attempt > 0);
          const client = this.createClientFromCookies(session.cookies);
          const numericDevId = Number(params.devId);
          const requestData = {
            sysKind: 8,
            appAccNo: Number(session.accNo) || session.accNo,
            memberKind: 1,
            resvMember: [Number(session.accNo) || session.accNo],
            resvBeginTime: `${params.targetDate} ${startTimeNorm}`,
            resvEndTime: `${params.targetDate} ${endTimeNorm}`,
            testName: '',
            captcha: '',
            resvProperty: 0,
            resvDev: [Number.isNaN(numericDevId) ? params.devId : numericDevId],
            memo: '',
          };

          const response = await client.post(
            `${appConfig.icspace.host}/ic-web/reserve`,
            requestData,
            {
              headers: {
                Token: session.token,
                'Content-Type': 'application/json',
              },
            },
          );

          if (response.data?.code === 0) {
            success = true;
            remoteResvId = String(response.data?.data?.uuid || response.data?.data?.resvId || '');
            message = `成功预约 ${areaName} ${params.seatName} (${params.targetDate} ${params.startTime}-${params.endTime})`;
            break;
          }

          const rawMsg = String(response.data?.message || '预约失败');
          if (attempt === 0 && /登录|token|未授权|过期/i.test(rawMsg)) {
            continue;
          }
          success = false;
          message = rawMsg;
          break;
        } catch (e: any) {
          if (attempt === 0) continue;
          success = false;
          message = e?.message || '请求图书馆预约接口异常';
        }
      }
    }

    const now = new Date().toISOString();
    let reservationId: number | undefined;

    if (success || params.source === 'manual') {
      const insert = this.dbService.db
        .prepare(
          `INSERT INTO reservations (
             user_id, student_id, student_name, unit_name,
             area_id, area_name, dev_id, seat_name,
             target_date, start_time, end_time, source, schedule_id,
             status, remote_resv_id, message, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          user.id,
          user.student_id,
          user.name,
          user.unit_name,
          params.areaId,
          areaName,
          params.devId,
          params.seatName,
          params.targetDate,
          params.startTime,
          params.endTime,
          params.source,
          params.scheduleId ?? null,
          success ? 'success' : 'failed',
          remoteResvId || null,
          message,
          now,
        );
      reservationId = Number(insert.lastInsertRowid);
    }

    if (success) {
      this.dbService.incrementMetric('total_successful_bookings', 1);
    }

    return { success, message, remoteResvId, reservationId };
  }

  /**
   * 按区域优先级、心仪座位号优先级、座位范围与最低空闲率寻找最佳可预约座位。
   */
  async findBestSeatCandidate(
    user: UserRow,
    options: {
      areaIds: string[];
      targetDate: string;
      startTime: string;
      endTime: string;
      preferredSeats: number[];
      seatMin: number;
      seatMax: number;
      minFreeRate: number;
      forceFullRange: boolean;
    },
  ): Promise<{ seat: SeatInfo; slot: TimeSlot } | null> {
    const startMin = this.timeToMinutes(options.startTime);
    const endMin = this.timeToMinutes(options.endTime);

    for (const areaId of options.areaIds) {
      try {
        const res = await this.fetchAreaSeats(
          user,
          areaId,
          options.targetDate,
          options.startTime,
          options.endTime,
        );
        if (!res.seats.length) continue;

        const isEligible = (seat: SeatInfo): TimeSlot | null => {
          const slot = seat.longestFreeSlot;
          if (!slot || slot.durationMin < 30) return null;
          if (seat.freeRate < options.minFreeRate) return null;
          if (options.forceFullRange && (slot.start > startMin || slot.end < endMin)) {
            return null;
          }
          return slot;
        };

        // 1. 优先匹配心仪座位号
        if (options.preferredSeats.length > 0) {
          for (const prefNum of options.preferredSeats) {
            const seat = res.seats.find((s) => s.seatNumber === prefNum);
            if (!seat) continue;
            const slot = isEligible(seat);
            if (slot) return { seat, slot };
          }
        }

        // 2. 在座位号范围内选择最长空闲时间段
        let best: { seat: SeatInfo; slot: TimeSlot } | null = null;
        for (const seat of res.seats) {
          if (seat.seatNumber < options.seatMin || seat.seatNumber > options.seatMax) {
            continue;
          }
          const slot = isEligible(seat);
          if (!slot) continue;
          if (!best || slot.durationMin > best.slot.durationMin) {
            best = { seat, slot };
          }
        }

        if (best) return best;
      } catch (e: any) {
        this.logger.warn(`Area ${areaId} seat scan failed: ${e?.message}`);
      }
    }

    return null;
  }
}
