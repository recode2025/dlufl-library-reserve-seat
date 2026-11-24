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
  status: 'free' | 'partial' | 'occupied' | 'unreleased';
  freeRate: number;
  longestFreeSlot: TimeSlot | null;
  freeSlots: TimeSlot[];
  busySlots: TimeSlot[];
}

export interface BatchReleaseStatus {
  state: 'open' | 'unreleased' | 'expired' | 'closed';
  bookable: boolean;
  releaseAt?: string;
  message: string;
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
  // 上游房间座位快照 3 秒合并缓存：多用户同时刷新/轮询同一区域时，每 3 秒最多向上游 ICSpace 发起 1 次请求，防限流封禁
  private readonly areaRawCache = new Map<string, { data: any[]; fetchedAt: number }>();
  private readonly AREA_CACHE_TTL_MS = 3000;

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

  private getBeijingNowInfo(now = new Date()) {
    const bjParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);

    const get = (type: string) => bjParts.find((p) => p.type === type)?.value || '00';
    const hour = Number(get('hour')) % 24;
    const minute = Number(get('minute'));
    return {
      year: Number(get('year')),
      month: Number(get('month')),
      day: Number(get('day')),
      hour,
      minute,
      todayStr: `${get('year')}-${get('month')}-${get('day')}`,
      currentMin: hour * 60 + minute,
    };
  }

  private toBeijingTimestamp(dateStr: string, timeStr: string): number {
    const normalized = timeStr.length === 5 ? `${timeStr}:00` : timeStr;
    return new Date(`${dateStr}T${normalized}+08:00`).getTime();
  }

  /**
   * 依据实时抓取的 ICSpace 上游数据包（openTimes / resvRule / resvInfo）判断某日期与座位是否已开放预约，
   * 不再凭本地时间硬猜（彻底杜绝 00:xx 误判或图书馆临时调整放座时间导致的错判）。
   */
  evaluateDeviceFromPacket(
    device: any,
    targetDate: string,
    requestedStart: string,
    requestedEnd: string,
    hasAnyActiveBookingInRoom: boolean,
    now = new Date(),
  ): {
    bookable: boolean;
    reason?: string;
    releaseAt?: string;
    busySlots: TimeSlot[];
    freeSlots: TimeSlot[];
    longestFreeSlot: TimeSlot | null;
    freeRate: number;
    status: SeatInfo['status'];
  } {
    const bj = this.getBeijingNowInfo(now);
    const todayUtc = Date.UTC(bj.year, bj.month - 1, bj.day);
    const [ty, tm, td] = targetDate.split('-').map(Number);
    const targetUtc = Date.UTC(ty, tm - 1, td);
    const diffDays = Math.round((targetUtc - todayUtc) / (24 * 60 * 60 * 1000));

    if (diffDays < 0) {
      return {
        bookable: false,
        reason: `${targetDate} 批次已过期`,
        busySlots: [],
        freeSlots: [],
        longestFreeSlot: null,
        freeRate: 0,
        status: 'unreleased',
      };
    }

    const resvRule = device?.resvRule && typeof device.resvRule === 'object' ? device.resvRule : null;
    const hasRule = Boolean(resvRule && Object.keys(resvRule).length > 0);
    const rawOpenTimes: Array<{ openStartTime?: string; openEndTime?: string }> = Array.isArray(
      device?.openTimes,
    )
      ? device.openTimes
      : [];

    // 1. 直接读取 ICSpace 数据包里的 openTimes 与 resvRule（与官方前端 judgeReserve 完全一致）
    if (device?.openTimes !== undefined && rawOpenTimes.length === 0) {
      return {
        bookable: false,
        reason: `ICSpace 返回 ${targetDate} 无开放时段（未放座或闭馆）`,
        busySlots: [],
        freeSlots: [],
        longestFreeSlot: null,
        freeRate: 0,
        status: 'unreleased',
      };
    }
    if (device?.resvRule !== undefined && !hasRule) {
      return {
        bookable: false,
        reason: `ICSpace 返回 ${targetDate} 无可用预约规则（未放座）`,
        busySlots: [],
        freeSlots: [],
        longestFreeSlot: null,
        freeRate: 0,
        status: 'unreleased',
      };
    }
    if (device?.devProp !== undefined && (Number(device.devProp) & 2) === 0) {
      return {
        bookable: false,
        reason: '该座位当前不可预约',
        busySlots: [],
        freeSlots: [],
        longestFreeSlot: null,
        freeRate: 0,
        status: 'unreleased',
      };
    }

    // 确定该日期的实际开放起止时间（优先取 ICSpace 实时返回的 openTimes / openStart / openEnd）
    const openWindows: Array<{ start: number; end: number }> = [];
    if (rawOpenTimes.length > 0) {
      for (const ot of rawOpenTimes) {
        if (ot.openStartTime && ot.openEndTime) {
          const s = this.timeToMinutes(ot.openStartTime.slice(0, 5));
          const e = this.timeToMinutes(ot.openEndTime.slice(0, 5));
          if (e > s) openWindows.push({ start: s, end: e });
        }
      }
    }
    if (openWindows.length === 0) {
      const os = device?.openStart ? this.timeToMinutes(String(device.openStart).slice(0, 5)) : 8 * 60;
      const oe = device?.openEnd ? this.timeToMinutes(String(device.openEnd).slice(0, 5)) : 22 * 60;
      if (oe > os) openWindows.push({ start: os, end: oe });
    }

    const minResvTime = Math.max(15, Number(resvRule?.minResvTime || 30));
    const earliestResvTime = Number(resvRule?.earliestResvTime ?? -1);
    const latestResvTime = Math.max(0, Number(resvRule?.latestResvTime ?? 0));

    // 2. 按 ICSpace 实时返回的 resvRule.earliestResvTime 判定目标日期是否已到提前预约窗口
    //    若房间数据包中已存在有效预约记录，说明上游已放座，直接视为已开放
    const nowMs = now.getTime();
    let maxAllowedStartMs = Number.POSITIVE_INFINITY;
    if (!hasAnyActiveBookingInRoom && hasRule && earliestResvTime >= 0) {
      if (earliestResvTime === 0 && latestResvTime === 0) {
        if (diffDays > 0) {
          return {
            bookable: false,
            reason: `ICSpace 规则当前仅开放当日（${bj.todayStr}）预约，${targetDate} 尚未放座`,
            busySlots: [],
            freeSlots: [],
            longestFreeSlot: null,
            freeRate: 0,
            status: 'unreleased',
          };
        }
      } else if (earliestResvTime > 0) {
        if (earliestResvTime % 1440 === 0) {
          const maxDays = earliestResvTime / 1440;
          if (diffDays > maxDays) {
            return {
              bookable: false,
              reason: `ICSpace 规则最多提前 ${maxDays} 天预约，${targetDate} 尚未放座`,
              busySlots: [],
              freeSlots: [],
              longestFreeSlot: null,
              freeRate: 0,
              status: 'unreleased',
            };
          }
        } else {
          maxAllowedStartMs = nowMs + earliestResvTime * 60 * 1000;
          const firstOpenStart = openWindows[0]?.start ?? 8 * 60;
          const firstSlotMs = this.toBeijingTimestamp(targetDate, this.minutesToTime(firstOpenStart));
          if (firstSlotMs > maxAllowedStartMs) {
            const releaseDateObj = new Date(firstSlotMs - earliestResvTime * 60 * 1000);
            const relBj = this.getBeijingNowInfo(releaseDateObj);
            const releaseAt = `${relBj.todayStr} ${String(relBj.hour).padStart(2, '0')}:${String(relBj.minute).padStart(2, '0')}`;
            return {
              bookable: false,
              reason: `按 ICSpace 实时规则（提前 ${earliestResvTime} 分钟开放），${targetDate} 将于 ${releaseAt} 放座`,
              releaseAt,
              busySlots: [],
              freeSlots: [],
              longestFreeSlot: null,
              freeRate: 0,
              status: 'unreleased',
            };
          }
        }
      }
    }

    // 3. 计算有效可约时段（与用户选择时段、ICSpace 实时开放时段、以及今日当前北京时间校准取交集）
    const calibrated = this.calibrateTimeRange(targetDate, requestedStart, requestedEnd, now);
    const reqStartMin = calibrated.effectiveStartMin;
    const reqEndMin = calibrated.effectiveEndMin;

    // 过滤掉 ICSpace 已取消/失效的预约记录（官方文档与前端逻辑：!(128 & resvStatus)）
    const activeRawResv = (Array.isArray(device?.resvInfo) ? device.resvInfo : []).filter(
      (item: any) => (Number(item?.resvStatus || 0) & 128) === 0,
    );

    const allBusySlots: TimeSlot[] = [];
    const allFreeSlots: TimeSlot[] = [];

    for (const win of openWindows) {
      let winStart = Math.max(win.start, reqStartMin);
      let winEnd = Math.min(win.end, reqEndMin);

      // 若是精确分钟提前窗口（earliestResvTime % 1440 !== 0），截断超过最大允许开始时间的边界
      if (Number.isFinite(maxAllowedStartMs)) {
        const winStartMs = this.toBeijingTimestamp(targetDate, this.minutesToTime(winStart));
        if (winStartMs > maxAllowedStartMs) continue;
      }

      // 应用 latestResvTime（今日最短提前时间）
      if (diffDays === 0 && latestResvTime > 0) {
        const minAllowedToday = bj.currentMin + latestResvTime;
        winStart = Math.max(winStart, minAllowedToday);
      }

      if (winEnd - winStart < minResvTime) continue;

      const { busySlots, freeSlots } = this.computeSeatIntervals(activeRawResv, winStart, winEnd);
      if (allBusySlots.length === 0) allBusySlots.push(...busySlots);
      for (const fs of freeSlots) {
        if (fs.durationMin >= minResvTime) {
          allFreeSlots.push(fs);
        }
      }
    }

    // 若用户所选时段在今日已全部过去，依然保留原始占用条用于展示，但空闲列表为空
    if (allBusySlots.length === 0 && activeRawResv.length > 0) {
      const fallbackInterval = this.computeSeatIntervals(activeRawResv, 8 * 60, 22 * 60);
      allBusySlots.push(...fallbackInterval.busySlots);
    }

    let longestFreeSlot: TimeSlot | null = null;
    for (const slot of allFreeSlots) {
      if (!longestFreeSlot || slot.durationMin > longestFreeSlot.durationMin) {
        longestFreeSlot = slot;
      }
    }

    const totalRange = Math.max(1, reqEndMin - reqStartMin);
    const freeRate = longestFreeSlot
      ? Math.min(100, Math.round((longestFreeSlot.durationMin / totalRange) * 100))
      : 0;

    let status: SeatInfo['status'] = 'occupied';
    if (longestFreeSlot && freeRate >= 98) status = 'free';
    else if (longestFreeSlot && longestFreeSlot.durationMin >= minResvTime) status = 'partial';

    return {
      bookable: true,
      busySlots: allBusySlots,
      freeSlots: allFreeSlots,
      longestFreeSlot,
      freeRate,
      status,
    };
  }

  /**
   * 校准实际可预约时间范围：
   * - 当 targetDate 为今日且用户所选开始时间已早于当前北京时间时，自动校准为「当前时间 + 2 分钟」
   * - 保证轮询或手动预约在空闲区间中途开始时，依然可以直接从当前时刻起约到该空位
   */
  calibrateTimeRange(
    targetDate: string,
    requestedStart: string,
    requestedEnd: string,
    now = new Date(),
  ) {
    const bj = this.getBeijingNowInfo(now);
    const reqStartMin = this.timeToMinutes(requestedStart);
    const reqEndMin = this.timeToMinutes(requestedEnd);

    let effectiveStartMin = reqStartMin;
    let calibrated = false;
    if (targetDate === bj.todayStr) {
      const minBookableNow = Math.min(22 * 60, bj.currentMin + 2);
      if (minBookableNow > effectiveStartMin) {
        effectiveStartMin = minBookableNow;
        calibrated = true;
      }
    }

    const effectiveEndMin = reqEndMin;
    const hasValidWindow = effectiveEndMin - effectiveStartMin >= 30;
    return {
      effectiveStartMin,
      effectiveEndMin,
      effectiveStartTime: this.minutesToTime(effectiveStartMin),
      effectiveEndTime: this.minutesToTime(effectiveEndMin),
      calibrated,
      hasValidWindow,
    };
  }

  /**
   * 统一按北京时间 (Asia/Shanghai) 计算图书馆放座批次状态：
   * 规则：每天 18:00 开放次日座位。
   * - targetDate < 今日：已过期
   * - targetDate === 今日：已放座（22:00 后提示已闭馆）
   * - targetDate === 明日：今日 18:00 前为 unreleased（未放座），18:00 及之后为 open
   * - targetDate > 明日：unreleased（未放座，将于目标日期前一天 18:00 开放）
   */
  getBatchReleaseStatus(targetDate: string, now = new Date()): BatchReleaseStatus {
    const bj = this.getBeijingNowInfo(now);
    const todayStr = bj.todayStr;
    const currentMin = bj.currentMin;

    const todayUtc = Date.UTC(bj.year, bj.month - 1, bj.day);
    const [ty, tm, td] = targetDate.split('-').map(Number);
    const targetUtc = Date.UTC(ty, tm - 1, td);
    const diffDays = Math.round((targetUtc - todayUtc) / (24 * 60 * 60 * 1000));

    if (diffDays < 0) {
      return {
        state: 'expired',
        bookable: false,
        message: `${targetDate} 批次已过期，无法预约历史日期座位。`,
      };
    }

    if (diffDays === 0) {
      if (currentMin >= 22 * 60) {
        return {
          state: 'closed',
          bookable: false,
          message: `今日（${todayStr}）图书馆已到 22:00 闭馆时间，请切换至明日批次。`,
        };
      }
      return {
        state: 'open',
        bookable: true,
        message: `今日（${todayStr}）批次已开放预约。`,
      };
    }

    if (diffDays === 1) {
      if (currentMin < 18 * 60) {
        return {
          state: 'unreleased',
          bookable: false,
          releaseAt: `${todayStr} 18:00`,
          message: `明日（${targetDate}）座位批次尚未放座，将于今日 18:00 开放；可先点击心仪座位提前设置 18:01 自动抢座。`,
        };
      }
      return {
        state: 'open',
        bookable: true,
        message: `明日（${targetDate}）批次已于今日 18:00 放座，当前可直接预约。`,
      };
    }

    const prevDay = new Date(targetUtc - 24 * 60 * 60 * 1000);
    const releaseDate = `${prevDay.getUTCFullYear()}-${String(prevDay.getUTCMonth() + 1).padStart(2, '0')}-${String(prevDay.getUTCDate()).padStart(2, '0')}`;
    return {
      state: 'unreleased',
      bookable: false,
      releaseAt: `${releaseDate} 18:00`,
      message: `${targetDate} 座位批次尚未放座，预计于 ${releaseDate} 18:00 开放；可先选中心仪座号配置定期预约。`,
    };
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
    effectiveStartTime: string;
    effectiveEndTime: string;
    timeCalibrated: boolean;
    isLive: boolean;
    batchStatus: BatchReleaseStatus;
    notice?: string;
    summary: { total: number; free: number; partial: number; occupied: number; unreleased: number };
    seats: SeatInfo[];
  }> {
    const area = this.getAreaById(areaId);
    if (!area) {
      throw new BadRequestException(`未知的图书馆区域 ID: ${areaId}`);
    }

    const batchStatus = this.getBatchReleaseStatus(targetDate);
    const calibratedRange = this.calibrateTimeRange(targetDate, startTime, endTime);

    if (appConfig.mockMode) {
      const seats = this.generateMockSeats(
        area,
        targetDate,
        calibratedRange.effectiveStartTime,
        calibratedRange.effectiveEndTime,
      ).map((s) =>
        batchStatus.bookable && calibratedRange.hasValidWindow
          ? s
          : {
              ...s,
              status: batchStatus.bookable ? ('occupied' as const) : ('unreleased' as const),
              freeRate: 0,
              longestFreeSlot: null,
              freeSlots: [],
            },
      );
      return {
        area,
        targetDate,
        startTime,
        endTime,
        effectiveStartTime: calibratedRange.effectiveStartTime,
        effectiveEndTime: calibratedRange.effectiveEndTime,
        timeCalibrated: calibratedRange.calibrated,
        isLive: false,
        batchStatus,
        notice: batchStatus.bookable
          ? calibratedRange.hasValidWindow
            ? '当前处于演练模式（ICSPACE_MOCK_MODE=true），座位状态由本地模拟器与真实预约库联合生成。'
            : '当前所选结束时间距现在不足 30 分钟，请调晚结束时间或切换明日批次。'
          : batchStatus.message,
        summary: this.summarizeSeats(seats),
        seats,
      };
    }

    const startMin = calibratedRange.effectiveStartMin;
    const endMin = calibratedRange.effectiveEndMin;
    const compactDate = targetDate.replace(/-/g, '');
    const apiUrl = `${appConfig.icspace.host}/ic-web/reserve?roomIds=${area.id}&resvDates=${compactDate}&sysKind=8&_=${Date.now()}`;
    const cacheKey = `${area.id}:${compactDate}`;

    let rawList: any[] | null = null;
    let isGuestPreview = !user || !user.icspace_bound;

    // 优先命中 3 秒上游合并缓存，避免多人高并发轮询同一区域打爆校园网 ICSpace
    const cachedSnapshot = this.areaRawCache.get(cacheKey);
    if (cachedSnapshot && Date.now() - cachedSnapshot.fetchedAt < this.AREA_CACHE_TTL_MS) {
      rawList = cachedSnapshot.data;
    }

    if (!rawList && (!user || !user.icspace_bound)) {
      isGuestPreview = true;
      // 1) 未登录/未绑定时，先尝试公开接口直拉 ICSpace 座位状态
      try {
        const pubResp = await axios.get(apiUrl, {
          headers: this.buildHeaders(),
          timeout: 10000,
        });
        if (pubResp.data?.code === 0 && Array.isArray(pubResp.data?.data)) {
          const list: any[] = pubResp.data.data;
          rawList = list;
          this.areaRawCache.set(cacheKey, { data: list, fetchedAt: Date.now() });
        }
      } catch {
        // ignore anonymous error and try cached public reader session
      }

      // 2) 若 ICSpace 要求登录态，则复用任意一个已授权只读会话拉取公共房间座位占用（不暴露任何个人信息）
      if (!rawList) {
        const readerUser = this.dbService.db
          .prepare(
            `SELECT * FROM users WHERE icspace_bound = 1 AND encrypted_cas_password IS NOT NULL ORDER BY updated_at DESC LIMIT 1`,
          )
          .get() as UserRow | undefined;

        if (readerUser) {
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const session = await this.ensureUserSession(readerUser, attempt > 0);
              const client = this.createClientFromCookies(session.cookies);
              const response = await client.get(apiUrl);
              if (response.data?.code === 0 && Array.isArray(response.data?.data)) {
                const list: any[] = response.data.data;
                rawList = list;
                this.areaRawCache.set(cacheKey, { data: list, fetchedAt: Date.now() });
                break;
              }
            } catch {
              // continue retry
            }
          }
        }
      }

      if (!rawList) {
        return {
          area,
          targetDate,
          startTime,
          endTime,
          effectiveStartTime: calibratedRange.effectiveStartTime,
          effectiveEndTime: calibratedRange.effectiveEndTime,
          timeCalibrated: calibratedRange.calibrated,
          isLive: false,
          batchStatus,
          notice: !user
            ? '当前暂未获取到公共实时座位数据，请先通过 CAS 登录后授权 ICSpace 即可实时查座与预约。'
            : '请先完成「图书馆预约凭证授权」，即可实时加载大外 ICSpace 座位占用数据。',
          summary: { total: 0, free: 0, partial: 0, occupied: 0, unreleased: 0 },
          seats: [],
        };
      }
    } else if (!rawList && user) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const session = await this.ensureUserSession(user, attempt > 0);
        const client = this.createClientFromCookies(session.cookies);
        const response = await client.get(apiUrl);
        if (response.data?.code === 0 && Array.isArray(response.data?.data)) {
          const list: any[] = response.data.data;
          rawList = list;
          this.areaRawCache.set(cacheKey, { data: list, fetchedAt: Date.now() });
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
    }

    const hasAnyActiveBookingInRoom = (rawList || []).some((device: any) =>
      (Array.isArray(device?.resvInfo) ? device.resvInfo : []).some(
        (item: any) => (Number(item?.resvStatus || 0) & 128) === 0,
      ),
    );

    let packetUnreleasedReason: string | undefined;
    let packetReleaseAt: string | undefined;

    const seats: SeatInfo[] = (rawList || []).map((device: any, idx: number) => {
      const devName = String(device.devName || `${area.name}-${idx + 1}`);
      const seatNumber = this.extractSeatNumber(devName, idx);

      const evaluated = this.evaluateDeviceFromPacket(
        device,
        targetDate,
        startTime,
        endTime,
        hasAnyActiveBookingInRoom,
      );

      if (!evaluated.bookable && !packetUnreleasedReason) {
        packetUnreleasedReason = evaluated.reason;
        packetReleaseAt = evaluated.releaseAt;
      }

      return {
        devId: String(device.devId),
        devName,
        seatNumber,
        areaId: area.id,
        areaName: area.name,
        status: evaluated.status,
        freeRate: evaluated.freeRate,
        longestFreeSlot: evaluated.longestFreeSlot,
        freeSlots: evaluated.freeSlots,
        busySlots: evaluated.busySlots,
      };
    });

    seats.sort((a, b) => a.seatNumber - b.seatNumber);

    const allUnreleased = seats.length > 0 && seats.every((s) => s.status === 'unreleased');
    const effectiveBatchStatus: BatchReleaseStatus = allUnreleased
      ? {
          state: 'unreleased',
          bookable: false,
          releaseAt: packetReleaseAt,
          message:
            packetUnreleasedReason ||
            `ICSpace 实时数据显示 ${targetDate} 批次尚未开放预约。`,
        }
      : {
          state: 'open',
          bookable: true,
          message: `${targetDate} 批次已开放预约（依据 ICSpace 实时数据包判定）。`,
        };

    let finalNotice: string | undefined;
    if (!effectiveBatchStatus.bookable) {
      finalNotice = effectiveBatchStatus.message;
    } else if (!calibratedRange.hasValidWindow) {
      finalNotice = '当前所选结束时间距现在不足 30 分钟，请调晚结束时间或切换至已开放的次日批次。';
    } else if (isGuestPreview) {
      finalNotice = !user
        ? '当前为未登录实时查座模式，支持 AJAX 自动刷新；登录后即可一键预约或配置 18:01 自动抢座。'
        : '当前为只读预览模式；完成「授权图书馆 ICSpace」后即可一键预约或开启 18:01 自动抢座。';
    }

    return {
      area,
      targetDate,
      startTime,
      endTime,
      effectiveStartTime: calibratedRange.effectiveStartTime,
      effectiveEndTime: calibratedRange.effectiveEndTime,
      timeCalibrated: calibratedRange.calibrated,
      isLive: true,
      batchStatus: effectiveBatchStatus,
      notice: finalNotice,
      summary: this.summarizeSeats(seats),
      seats,
    };
  }

  private summarizeSeats(seats: SeatInfo[]) {
    let free = 0;
    let partial = 0;
    let occupied = 0;
    let unreleased = 0;
    for (const s of seats) {
      if (s.status === 'free') free++;
      else if (s.status === 'partial') partial++;
      else if (s.status === 'unreleased') unreleased++;
      else occupied++;
    }
    return { total: seats.length, free, partial, occupied, unreleased };
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

    // 预约前再次按北京时间校准开始时间，确保轮询过程中即使处于空闲区间中途也能立即起约
    const calibrated = this.calibrateTimeRange(
      params.targetDate,
      params.startTime.slice(0, 5),
      params.endTime.slice(0, 5),
    );
    if (!calibrated.hasValidWindow) {
      return {
        success: false,
        message: '可预约时长不足 30 分钟，请调晚结束时间或切换至明日批次',
      };
    }

    const actualStart = calibrated.effectiveStartTime;
    const actualEnd = calibrated.effectiveEndTime;
    const startTimeNorm = `${actualStart}:00`;
    const endTimeNorm = `${actualEnd}:00`;

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
        message = `成功预约 ${areaName} ${params.seatName} (${params.targetDate} ${actualStart}-${actualEnd})`;
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
            message = `成功预约 ${areaName} ${params.seatName} (${params.targetDate} ${actualStart}-${actualEnd})`;
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
          actualStart,
          actualEnd,
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
      this.areaRawCache.delete(`${params.areaId}:${params.targetDate.replace(/-/g, '')}`);
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
    const calibrated = this.calibrateTimeRange(
      options.targetDate,
      options.startTime,
      options.endTime,
    );
    if (!calibrated.hasValidWindow) return null;
    const startMin = calibrated.effectiveStartMin;
    const endMin = calibrated.effectiveEndMin;

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
