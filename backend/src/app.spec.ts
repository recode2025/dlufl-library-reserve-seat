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
});
