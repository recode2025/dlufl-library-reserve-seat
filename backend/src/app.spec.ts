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

  before(() => {
    appConfig.mockMode = true;
    dbPath = path.join(os.tmpdir(), `dlufl-lib-test-${Date.now()}.db`);
    dbService = new DatabaseService();
    dbService.onModuleDestroy();
    (dbService as any).db = undefined;
    dbService.init(dbPath);
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

    const seatsRes = await icspService.fetchAreaSeats(
      user,
      '100475787',
      '2026-11-25',
      '08:30',
      '22:00',
    );
    assert.ok(seatsRes.seats.length > 0);
    const freeSeat = seatsRes.seats.find((s) => s.status === 'free');
    assert.ok(freeSeat, 'Expected at least one free seat in mock mode');

    const bookRes = await icspService.reserveSeat(user, {
      areaId: freeSeat.areaId,
      devId: freeSeat.devId,
      seatName: freeSeat.devName,
      targetDate: '2026-11-25',
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
      pollIntervalSec: 2,
      maxPollMinutes: 0,
    });

    // 先模拟第 1 次扫描无座 -> 验证保持 polling 状态并累计 pollAttempts
    const origFind = icspService.findBestSeatCandidate.bind(icspService);
    let callCount = 0;
    icspService.findBestSeatCandidate = async (...args) => {
      callCount++;
      if (callCount === 1) return null; // 模拟 18:01 第一轮无座
      return origFind(...args); // 第二轮轮询发现退座空位！
    };

    try {
      // 模拟当天 18:01:00 触发
      const triggerNow = new Date(2026, 10, 24, 18, 1, 0);
      await schedulerService.processScheduledTick(triggerNow);
      // 等待异步首轮完成
      await new Promise((r) => setTimeout(r, 80));

      const afterFirst = schedulerService.listUserTasks(user.id).find((t) => t.id === task.id)!;
      assert.equal(afterFirst.status, 'polling');
      assert.equal(afterFirst.pollAttempts, 1);
      assert.equal(afterFirst.activeTargetDate, '2026-11-25');

      // 模拟 3 秒后轮询下一拍 -> 发现空位并成功约上
      const pollNow = new Date(2026, 10, 24, 18, 1, 4);
      // 确保 last_run_at 距今超过 poll_interval_sec
      dbService.db
        .prepare(`UPDATE scheduled_tasks SET last_run_at = ? WHERE id = ?`)
        .run(new Date(pollNow.getTime() - 5000).toISOString(), task.id);

      await schedulerService.processScheduledTick(pollNow);
      await new Promise((r) => setTimeout(r, 80));

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
});
