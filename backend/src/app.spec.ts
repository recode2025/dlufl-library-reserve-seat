import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appConfig } from './config/app.config';
import { DatabaseService } from './database/database.service';
import { CasService } from './auth/cas.service';
import { IcspService } from './library/icspace.service';
import { SchedulerService } from './library/scheduler.service';
import { StatsService } from './stats/stats.service';
import { decryptSecret, encryptSecret } from './common/crypto.util';

describe('DLUFL Library System Core Flows', () => {
  let dbPath: string;
  let dbService: DatabaseService;
  let casService: CasService;
  let icspService: IcspService;
  let schedulerService: SchedulerService;
  let statsService: StatsService;
  const origMockMode = appConfig.mockMode;

  before(async () => {
    appConfig.mockMode = true;
    dbPath = path.join(os.tmpdir(), `dlufl-lib-test-${Date.now()}.db`);
    dbService = new DatabaseService();
    await dbService.init(dbPath);
    casService = new CasService(dbService);
    icspService = new IcspService(dbService);
    schedulerService = new SchedulerService(dbService, icspService, casService);
    statsService = new StatsService(dbService, schedulerService);
  });

  after(() => {
    appConfig.mockMode = origMockMode;
    dbService.onModuleDestroy();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = `${dbPath}${suffix}`;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('encrypts and decrypts ICSpace credentials with AES-256-GCM', () => {
    const cipher = encryptSecret('MyCampusPass#2026');
    assert.notEqual(cipher, 'MyCampusPass#2026');
    assert.equal(decryptSecret(cipher), 'MyCampusPass#2026');
  });

  it('parses Neusoft DLUFL-CAS proxyValidate XML and supports first + second login cleanly', async () => {
    const sampleXml = `
      <sso:serviceResponse xmlns:sso="http://www.neusoft.com/cas">
        <sso:authenticationSuccess>
          <sso:user>2023041101</sso:user>
          <sso:attributes>
            <sso:attribute name="user_id" value="u_99881" />
            <sso:attribute name="id_number" value="2023041101" />
            <sso:attribute name="user_name" value="林晓辰" />
            <sso:attribute name="unit_name" value="软件学院" />
            <sso:attribute name="id_type" value="1" />
          </sso:attributes>
        </sso:authenticationSuccess>
      </sso:serviceResponse>
    `;

    const parsed = await casService.parseProxyValidateXml(sampleXml);
    assert.equal(parsed.success, true);
    if (!parsed.success) return;

    // 第一次登录
    const first = casService.upsertUserFromCas(parsed.data.userInfo);
    assert.equal(first.student_id, '2023041101');
    assert.equal(first.login_count, 1);

    // 第二次登录（不能报错，复用同 UID 且 login_count 递增）
    const second = casService.upsertUserFromCas({
      ...parsed.data.userInfo,
      unit_name: '软件学院（卓越班）',
    });
    assert.equal(second.id, first.id);
    assert.equal(second.login_count, 2);
    assert.equal(second.unit_name, '软件学院（卓越班）');

    // 验证 CAS 重定向 URL 格式（含 renew 参数）
    const loginUrl = casService.getCasLoginRedirectUrl(
      'http://localhost:5173/api/auth/cas/callback',
      false,
    );
    assert.equal(
      loginUrl,
      'https://cas.dlufl.edu.cn/cas/login?service=http%3A%2F%2Flocalhost%3A5173%2Fapi%2Fauth%2Fcas%2Fcallback',
    );
    const renewUrl = casService.getCasLoginRedirectUrl(
      'http://localhost:5173/api/auth/cas/callback',
      true,
    );
    assert.ok(renewUrl.includes('renew=true'));

    // 验证 Nginx 代理头透传公网域名时，即使 .env 残留 localhost，也不会跳回 localhost:18517
    const prevPub = appConfig.publicBaseUrl;
    const prevFe = appConfig.frontendUrl;
    try {
      appConfig.publicBaseUrl = 'http://localhost:18517';
      appConfig.frontendUrl = 'http://localhost:18517';
      const fakeReq: any = {
        protocol: 'http',
        headers: {
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'lib.example.edu.cn',
          host: '127.0.0.1:18301',
        },
      };
      assert.equal(
        casService.getCallbackUrl(fakeReq),
        'https://lib.example.edu.cn/api/auth/cas/callback',
      );
      assert.equal(casService.getFrontendBaseUrl(fakeReq), 'https://lib.example.edu.cn');
    } finally {
      appConfig.publicBaseUrl = prevPub;
      appConfig.frontendUrl = prevFe;
    }
  });

  it('supports area seat browsing, manual booking, visit metrics, and card query', async () => {
    const user = casService.upsertUserFromCas({
      user_id: 'u_99881',
      id_number: '2023041101',
      user_name: '林晓辰',
      unit_name: '软件学院',
      id_type: '1',
    });
    icspService.markMockBound(user.id);

    const visit1 = statsService.recordVisit('127.0.0.1', 'Mozilla/5.0', '/');
    const visit2 = statsService.recordVisit('127.0.0.1', 'Mozilla/5.0', '/');
    assert.equal(visit2.totalVisits, visit1.totalVisits + 1);

    const todayDate = schedulerService.formatDateLocal(new Date());
    const seatsRes = await icspService.fetchAreaSeats(
      user,
      '100475787',
      todayDate,
      '08:30',
      '22:00',
    );
    assert.ok(seatsRes.seats.length > 0);
    assert.equal(seatsRes.batchStatus.state, 'open');
    const freeSeat = seatsRes.seats.find((s) => s.status === 'free');
    assert.ok(freeSeat, 'Expected at least one free seat in mock mode');

    // 验证 00:42 凌晨时钟不出现 24:42 误判，且完全按 ICSpace 实时数据包判定放座批次
    const midnightNow = new Date('2026-11-25T00:42:00+08:00');
    assert.equal(icspService.getBatchReleaseStatus('2026-11-25', midnightNow).state, 'open');
    assert.equal(icspService.getBatchReleaseStatus('2026-11-26', midnightNow).state, 'unreleased');

    // 实时数据包测试 1：当日 00:42，ICSpace 返回 openTimes + earliestResvTime=840（提前14小时，即前晚18:00放次日08:00）
    const todayPacket = icspService.evaluateDeviceFromPacket(
      {
        devId: 1,
        devName: '2M-001',
        devProp: 2,
        openStart: '08:00',
        openEnd: '22:00',
        openTimes: [{ openStartTime: '08:00', openEndTime: '22:00' }],
        resvRule: { earliestResvTime: 840, latestResvTime: 0, minResvTime: 30, maxResvTime: 840 },
        resvInfo: [],
      },
      '2026-11-25',
      '08:30',
      '22:00',
      true,
      midnightNow,
    );
    assert.equal(todayPacket.bookable, true);
    assert.equal(todayPacket.status, 'free');

    // 实时数据包测试 1b：验证 resvInfo 毫秒时间戳严格按北京时间(+08:00)解析，不受服务器 UTC 时区偏移影响
    const busyPacket = icspService.evaluateDeviceFromPacket(
      {
        devId: 2,
        devName: '2M-002',
        devProp: 2,
        openStart: '08:00',
        openEnd: '22:00',
        openTimes: [{ openStartTime: '08:00', openEndTime: '22:00' }],
        resvRule: { earliestResvTime: 840, latestResvTime: 0, minResvTime: 30, maxResvTime: 840 },
        resvInfo: [
          {
            start: new Date('2026-11-25T08:30:00+08:00').getTime(),
            end: new Date('2026-11-25T14:00:00+08:00').getTime(),
            resvStatus: 1027,
          },
        ],
      },
      '2026-11-25',
      '08:30',
      '22:00',
      true,
      midnightNow,
    );
    assert.equal(busyPacket.status, 'partial');
    assert.equal(busyPacket.busySlots.length, 1);
    assert.equal(busyPacket.busySlots[0].startStr, '08:30');
    assert.equal(busyPacket.busySlots[0].endStr, '14:00');
    assert.equal(busyPacket.freeSlots[0].startStr, '14:00');
    assert.equal(busyPacket.freeSlots[0].endStr, '22:00');

    // 实时数据包测试 1c：每个座位独立 openTimes（如 08:00-21:00）与 maxResvTime 必须精确透出
    const customOpenPacket = icspService.evaluateDeviceFromPacket(
      {
        devId: 3,
        devName: '6E-018',
        devProp: 2,
        openTimes: [{ openStartTime: '08:00', openEndTime: '21:00' }],
        resvRule: { earliestResvTime: 840, latestResvTime: 0, minResvTime: 30, maxResvTime: 240 },
        resvInfo: [
          {
            start: new Date('2026-11-25T10:00:00+08:00').getTime(),
            end: new Date('2026-11-25T13:00:00+08:00').getTime(),
            resvStatus: 1027,
          },
        ],
      },
      '2026-11-25',
      '08:00',
      '21:00',
      true,
      midnightNow,
    );
    assert.equal(customOpenPacket.openStart, '08:00');
    assert.equal(customOpenPacket.openEnd, '21:00');
    assert.equal(customOpenPacket.bookableStart, '08:00');
    assert.equal(customOpenPacket.bookableEnd, '21:00');
    assert.equal(customOpenPacket.rule.maxResvTime, 240);
    assert.equal(customOpenPacket.freeSlots.length, 2);
    assert.equal(customOpenPacket.freeSlots[1].endStr, '21:00');

    // 验证单座实时详情接口 fetchSeatDetail 在模拟模式下返回完整起止时间与规则
    const detailRes = await icspService.fetchSeatDetail(user, '100475787', freeSeat.devId, todayDate);
    assert.equal(detailRes.seat.devId, freeSeat.devId);
    assert.equal(detailRes.openStart, '08:00');
    assert.equal(detailRes.openEnd, '22:00');
    assert.ok(detailRes.rule.minResvTime >= 15);

    // 实时数据包测试 2：次日 2026-11-26 在 00:42 尚未放座（openTimes 为空 或 超出 earliestResvTime=840）
    const tomorrowPacket = icspService.evaluateDeviceFromPacket(
      {
        devId: 1,
        devName: '2M-001',
        devProp: 2,
        openStart: '08:00',
        openEnd: '22:00',
        openTimes: [{ openStartTime: '08:00', openEndTime: '22:00' }],
        resvRule: { earliestResvTime: 840, latestResvTime: 0, minResvTime: 30, maxResvTime: 840 },
        resvInfo: [],
      },
      '2026-11-26',
      '08:30',
      '22:00',
      false,
      midnightNow,
    );
    assert.equal(tomorrowPacket.bookable, false);
    assert.equal(tomorrowPacket.status, 'unreleased');
    assert.equal(tomorrowPacket.releaseAt, '2026-11-25 18:00');

    // 实时数据包测试 3：openTimes=[] 时无论时间如何，直接判定未放座
    const closedPacket = icspService.evaluateDeviceFromPacket(
      {
        devId: 1,
        devName: '2M-001',
        devProp: 2,
        openTimes: [],
        resvRule: { earliestResvTime: 1440, latestResvTime: 0 },
        resvInfo: [],
      },
      '2026-11-26',
      '08:30',
      '22:00',
      false,
      new Date('2026-11-25T19:00:00+08:00'),
    );
    assert.equal(closedPacket.bookable, false);
    assert.equal(closedPacket.status, 'unreleased');

    // 验证可约时间校准：若当前北京时间 14:20 已在空闲区间 [08:30, 22:00] 中途，应自动校准为 14:22-22:00 且仍可预约
    const midDayNow = new Date(`${todayDate}T14:20:00+08:00`);
    const cal = icspService.calibrateTimeRange(todayDate, '08:30', '22:00', midDayNow);
    assert.equal(cal.calibrated, true);
    assert.equal(cal.effectiveStartTime, '14:22');
    assert.equal(cal.effectiveEndTime, '22:00');
    assert.equal(cal.hasValidWindow, true);

    // 未放座批次（后天+）不应显示为全空，应明确标记为 unreleased
    const futureDate = schedulerService.computeTargetDate(new Date(), 3);
    const futureRes = await icspService.fetchAreaSeats(
      user,
      '100475787',
      futureDate,
      '08:30',
      '22:00',
    );
    assert.equal(futureRes.batchStatus.state, 'unreleased');
    assert.equal(futureRes.summary.free, 0);
    assert.equal(futureRes.summary.unreleased, futureRes.seats.length);

    const bookRes = await icspService.reserveSeat(user, {
      areaId: freeSeat.areaId,
      devId: freeSeat.devId,
      seatName: freeSeat.devName,
      targetDate: todayDate,
      startTime: '08:30',
      endTime: '22:00',
      source: 'manual',
    });
    assert.equal(bookRes.success, true);

    const overview = statsService.getOverview(user);
    assert.ok(overview.totalSuccessfulBookings >= 1);
    assert.ok(overview.totalVisits >= 2);
    assert.equal(overview.registeredUsers, 1);

    // 验证解绑后统计立即扣减为 0，重新绑定同一学号恢复为 1（不会重复累加）
    icspService.unbindUserCredentials(user.id);
    assert.equal(statsService.getOverview(user).registeredUsers, 0);

    // 验证通过 CASTGC 免密自动绑定 ICSpace（无需存密码），且解绑时同步清空 encrypted_cas_tgc
    const tgcBind = await icspService.bindUserWithTgc(user, 'CASTGC=TGT-mock-123456');
    assert.equal(tgcBind.bound, true);
    const afterTgc = casService.findUserById(user.id)!;
    assert.equal(afterTgc.icspace_bound, 1);
    assert.ok(afterTgc.encrypted_cas_tgc);
    assert.equal(afterTgc.encrypted_cas_password, null);
    assert.equal(statsService.getOverview(afterTgc).registeredUsers, 1);

    icspService.unbindUserCredentials(user.id);
    const afterUnbind = casService.findUserById(user.id)!;
    assert.equal(afterUnbind.encrypted_cas_tgc, null);
    assert.equal(afterUnbind.icspace_bound, 0);

    icspService.markMockBound(user.id);
    assert.equal(statsService.getOverview(user).registeredUsers, 1);

    const cardRes = statsService.queryReservationCard('2023041101', user);
    assert.equal(cardRes.found, true);
    assert.equal(cardRes.card?.totalSuccess, 1);
    assert.equal(cardRes.card?.manualSuccess, 1);
    assert.equal(cardRes.card?.favoriteArea, '二楼中区');
  });

  it('triggers 18:01 schedule for next day and polls continuously until a seat is booked', async () => {
    const user = casService.upsertUserFromCas({
      user_id: 'u_99882',
      id_number: '2023041102',
      user_name: '周明远',
      unit_name: '英语学院',
      id_type: '1',
    });
    icspService.markMockBound(user.id);

    const task = schedulerService.createTask(user, {
      name: '18:01 自动抢二楼东区',
      areaIds: ['100475785'],
      preferredSeats: [],
      seatMin: 1,
      seatMax: 96,
      startTime: '08:30',
      endTime: '22:00',
      minFreeRate: 80,
      triggerTime: '18:01',
      targetDayOffset: 1,
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      isRecurring: true,
      pollIntervalSec: 1, // 故意传低于下限的值，验证服务端强制收紧为 5 秒
      maxPollMinutes: 0,
    });
    assert.equal(task.pollIntervalSec, 5);

    // 先模拟第 1 次扫描无座 -> 验证保持 polling 状态并累计 pollAttempts
    const origFind = icspService.findBestSeatCandidate.bind(icspService);
    let callCount = 0;
    icspService.findBestSeatCandidate = async (...args) => {
      callCount++;
      if (callCount === 1) return null; // 模拟 18:01 第一轮无座
      return origFind(...args); // 第二轮轮询发现退座空位！
    };

    try {
      // 模拟当天 18:01:00 触发（先覆盖当日日期确保与当前时钟对齐）
      const todayPrefix = schedulerService.formatDateLocal(new Date());
      const triggerNow = new Date(`${todayPrefix}T18:01:00+08:00`);
      const expectedTarget = schedulerService.computeTargetDate(triggerNow, 1);

      // 让批次状态检查按 triggerNow(18:01) 判定次日批次已放座
      const origBatchCheck = icspService.getBatchReleaseStatus.bind(icspService);
      icspService.getBatchReleaseStatus = (d: string) => origBatchCheck(d, triggerNow);

      await schedulerService.processScheduledTick(triggerNow);
      // 等待异步首轮完成
      await new Promise((r) => setTimeout(r, 80));

      const afterFirst = schedulerService.listUserTasks(user.id).find((t) => t.id === task.id)!;
      assert.equal(afterFirst.status, 'polling');
      assert.equal(afterFirst.pollAttempts, 1);
      assert.equal(afterFirst.activeTargetDate, expectedTarget);

      // 模拟 6 秒后轮询下一拍 -> 发现空位并成功约上
      const pollNow = new Date(triggerNow.getTime() + 6000);
      // 确保 last_run_at 距今超过 poll_interval_sec (5s)
      dbService.db
        .prepare(`UPDATE scheduled_tasks SET last_run_at = ? WHERE id = ?`)
        .run(new Date(pollNow.getTime() - 6000).toISOString(), task.id);

      await schedulerService.processScheduledTick(pollNow);
      await new Promise((r) => setTimeout(r, 80));

      icspService.getBatchReleaseStatus = origBatchCheck;

      const afterSecond = schedulerService.listUserTasks(user.id).find((t) => t.id === task.id)!;
      assert.equal(afterSecond.status, 'succeeded');
      assert.equal(afterSecond.pollAttempts, 2);
      assert.ok(afterSecond.lastSeatName?.includes('二楼东区'));

      // 卡片查询应统计到该用户的轮询捡漏成功次数
      const cardRes = statsService.queryReservationCard('2023041102', user);
      assert.equal(cardRes.found, true);
      assert.equal(cardRes.card?.totalSuccess, 1);
      assert.equal(cardRes.card?.pollingSuccess, 1);
    } finally {
      icspService.findBestSeatCandidate = origFind;
    }
  });

  it('persists and queries cleanly using sql.js fallback engine (Node 18/20 compatible)', async () => {
    const sqlJsPath = path.join(os.tmpdir(), `dlufl-sqljs-test-${Date.now()}.db`);
    const fallbackDb = new DatabaseService();
    try {
      await fallbackDb.init(sqlJsPath, 'sql.js');
      assert.equal(fallbackDb.engine, 'sql.js');

      const cas = new CasService(fallbackDb);
      const icsp = new IcspService(fallbackDb);
      const sched = new SchedulerService(fallbackDb, icsp, cas);
      const stats = new StatsService(fallbackDb, sched);

      const u1 = cas.upsertUserFromCas({
        user_id: 'u_sqljs_1',
        id_number: '20240001',
        user_name: '测试同学',
        unit_name: '软件学院',
        id_type: '1',
      });
      const u2 = cas.upsertUserFromCas({
        user_id: 'u_sqljs_1',
        id_number: '20240001',
        user_name: '测试同学',
        unit_name: '软件学院',
        id_type: '1',
      });
      assert.equal(u1.id, u2.id);
      assert.equal(u2.login_count, 2);

      const v = stats.recordVisit('127.0.0.1', 'UA', '/');
      assert.equal(v.totalVisits, 1);

      const res = await icsp.reserveSeat(u2, {
        areaId: '100475787',
        devId: '100475787_001',
        seatName: '2M-001',
        targetDate: '2026-11-25',
        startTime: '08:30',
        endTime: '22:00',
        source: 'manual',
      });
      assert.equal(res.success, true);

      fallbackDb.onModuleDestroy();

      // Reopen from disk to prove atomic persistence worked!
      const reopened = new DatabaseService();
      await reopened.init(sqlJsPath, 'sql.js');
      const stats2 = new StatsService(reopened, new SchedulerService(reopened, new IcspService(reopened), new CasService(reopened)));
      const ov = stats2.getOverview();
      assert.equal(ov.totalVisits, 1);
      assert.equal(ov.totalSuccessfulBookings, 1);
      const card = stats2.queryReservationCard('20240001');
      assert.equal(card.found, true);
      assert.equal(card.card?.totalSuccess, 1);
      reopened.onModuleDestroy();
    } finally {
      if (fs.existsSync(sqlJsPath)) fs.unlinkSync(sqlJsPath);
    }
  });

  it('converts upstream ICSpace / session errors in fetchAreaSeats into clean HttpExceptions instead of 500', async () => {
    const user = casService.upsertUserFromCas({
      user_id: 'u_err_test',
      id_number: '20249999',
      user_name: '异常测试',
      unit_name: '软件学院',
      id_type: '1',
    });
    const boundUser = {
      ...user,
      icspace_bound: 1,
      encrypted_cas_password: 'invalid-cipher-payload',
    };

    const prevMock = appConfig.mockMode;
    try {
      appConfig.mockMode = false;
      await assert.rejects(
        () => icspService.fetchAreaSeats(boundUser, '100475787', '2026-11-25', '08:30', '22:00'),
        (err: any) => err?.getStatus?.() === 400 && /解密失败/.test(err?.message || ''),
      );
    } finally {
      appConfig.mockMode = prevMock;
    }
  });
});
