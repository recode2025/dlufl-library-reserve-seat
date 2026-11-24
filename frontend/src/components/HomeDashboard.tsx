import React, { useEffect, useState } from 'react';
import {
  Activity,
  Award,
  Building2,
  CalendarClock,
  CheckCircle2,
  Clock,
  CreditCard,
  Eye,
  MapPin,
  Radio,
} from 'lucide-react';
import type { LibraryArea, OverviewStats, UserProfile } from '../types';

interface HomeDashboardProps {
  overview: OverviewStats | null;
  areas: LibraryArea[];
  user: UserProfile | null;
  onNavigate: (tab: 'home' | 'seats' | 'scheduler' | 'cards', areaId?: string) => void;
  onOpenLogin: () => void;
  onOpenBind: () => void;
}

function formatCountdown(totalSeconds: number) {
  const s = Math.max(0, totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function sourceLabel(source: 'manual' | 'scheduled' | 'polling') {
  if (source === 'scheduled') return '18:01 准点抢座';
  if (source === 'polling') return '轮询捡漏成功';
  return '网页手动选座';
}

export const HomeDashboard: React.FC<HomeDashboardProps> = ({
  overview,
  areas,
  user,
  onNavigate,
  onOpenLogin,
  onOpenBind,
}) => {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const grabTargetMs = overview?.countdown?.nextGrabAt
    ? new Date(overview.countdown.nextGrabAt).getTime()
    : null;
  const liveSecondsToGrab = grabTargetMs
    ? Math.max(0, Math.floor((grabTargetMs - Date.now()) / 1000))
    : overview?.countdown?.secondsToGrab ?? 0;

  // use tick so countdown updates smoothly each second
  void tick;

  const areaCountMap = new Map(
    (overview?.areaDistribution || []).map((a) => [a.areaId, a.successCount]),
  );

  return (
    <div className="space-y-6">
      {/* Hero Banner */}
      <section className="overflow-hidden rounded-2xl border border-[#DCE4EE] bg-white">
        <div className="grid gap-6 p-6 md:grid-cols-12 md:p-8">
          <div className="md:col-span-7">
            <div className="inline-flex items-center gap-2 rounded-full border border-[#DCE4EE] bg-[#F3F6FA] px-3 py-1 text-xs font-medium text-[#0D386B]">
              <Clock className="h-3.5 w-3.5 text-[#DF7900]" />
              每日 18:00 放次日座位 · 支持 18:01 自动开抢与无座持续轮询
            </div>
            <h1 className="mt-4 text-2xl font-bold tracking-tight text-[#0D223D] sm:text-3xl">
              大连外国语大学图书馆座位预约工作台
            </h1>
            <p className="mt-2.5 max-w-2xl text-sm leading-relaxed text-[#4D627A]">
              直连数字大外 CAS 统一身份认证与图书馆 ICSpace 空间系统。支持多楼层分区可视化选座、每日
              18:01 准点自动抢座、无空座时后台持续轮询捡漏直到约上，以及校园卡成功预约次数查询。
            </p>

            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => onNavigate('seats')}
                className="inline-flex items-center gap-2 rounded-lg bg-[#0D386B] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#0A2C55]"
              >
                <MapPin className="h-4 w-4" />
                进入区域选座
              </button>
              <button
                type="button"
                onClick={() => onNavigate('scheduler')}
                className="inline-flex items-center gap-2 rounded-lg border border-[#0D386B]/25 bg-[#F3F6FA] px-4 py-2.5 text-sm font-semibold text-[#0D386B] hover:bg-[#E7EEF7]"
              >
                <CalendarClock className="h-4 w-4" />
                配置 18:01 定期预约
              </button>
              <button
                type="button"
                onClick={() => onNavigate('cards')}
                className="inline-flex items-center gap-2 rounded-lg border border-[#DCE4EE] bg-white px-4 py-2.5 text-sm font-medium text-[#0D223D] hover:bg-[#F8FAFC]"
              >
                <CreditCard className="h-4 w-4 text-[#DF7900]" />
                查询预约次数卡片
              </button>
            </div>
          </div>

          {/* 18:01 Countdown Panel */}
          <div className="flex flex-col justify-between rounded-xl bg-[#0D386B] p-5 text-white md:col-span-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-blue-100">距离下次 18:01 自动开抢</span>
              <span className="rounded bg-[#DF7900] px-2 py-0.5 text-xs font-semibold text-white">
                目标 {overview?.countdown?.targetBookingDate || '次日'}
              </span>
            </div>

            <div className="my-4">
              <div className="font-mono text-4xl font-bold tracking-wider tabular-nums text-white sm:text-5xl">
                {formatCountdown(liveSecondsToGrab)}
              </div>
              <p className="mt-1.5 text-xs text-blue-100/85">
                每天 18:00 开放次日全馆座位，18:01 自动发车；若无空座自动转入轮询找座模式。
              </p>
            </div>

            <div className="flex items-center justify-between border-t border-white/15 pt-3 text-xs">
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    (overview?.activePollingTasks || 0) > 0
                      ? 'polling-dot bg-[#DF7900]'
                      : 'bg-emerald-400'
                  }`}
                />
                <span>
                  {(overview?.activePollingTasks || 0) > 0
                    ? `当前 ${overview?.activePollingTasks} 个任务正在轮询找座`
                    : `${overview?.activeSchedules || 0} 个定时规则待命`}
                </span>
              </div>
              {!user ? (
                <button
                  type="button"
                  onClick={onOpenLogin}
                  className="font-semibold text-amber-300 underline-offset-2 hover:underline"
                >
                  立即 CAS 登录
                </button>
              ) : !user.icspaceBound ? (
                <button
                  type="button"
                  onClick={onOpenBind}
                  className="font-semibold text-amber-300 underline-offset-2 hover:underline"
                >
                  绑定 ICSpace 启用抢座
                </button>
              ) : (
                <span className="text-emerald-300">抢座通道已就绪</span>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Persisted Site Metrics Strip (首页核心展示：成功约座次数 & 系统访问次数) */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-[#DCE4EE] bg-white p-5">
          <div className="flex items-center justify-between text-[#4D627A]">
            <span className="text-sm font-medium">累计成功约座次数</span>
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
          </div>
          <div className="mt-3 flex items-baseline gap-2.5">
            <span className="font-mono text-3xl font-bold tabular-nums text-[#0D223D]">
              {(overview?.totalSuccessfulBookings ?? 0).toLocaleString()}
            </span>
            <span className="text-xs font-medium text-emerald-700">
              今日 +{overview?.todaySuccessfulBookings ?? 0}
            </span>
          </div>
          <p className="mt-1.5 text-xs text-[#64748B]">包含网页手动选座与 18:01 自动/轮询成功</p>
        </div>

        <div className="rounded-xl border border-[#DCE4EE] bg-white p-5">
          <div className="flex items-center justify-between text-[#4D627A]">
            <span className="text-sm font-medium">系统累计访问次数</span>
            <Eye className="h-5 w-5 text-[#0D386B]" />
          </div>
          <div className="mt-3 flex items-baseline gap-2.5">
            <span className="font-mono text-3xl font-bold tabular-nums text-[#0D223D]">
              {(overview?.totalVisits ?? 0).toLocaleString()}
            </span>
            <span className="text-xs font-medium text-[#0D386B]">
              今日访问 {overview?.todayVisits ?? 0}
            </span>
          </div>
          <p className="mt-1.5 text-xs text-[#64748B]">实时持久化记录全站访问统计</p>
        </div>

        <div className="rounded-xl border border-[#DCE4EE] bg-white p-5">
          <div className="flex items-center justify-between text-[#4D627A]">
            <span className="text-sm font-medium">定时抢座 / 轮询状态</span>
            <Radio
              className={`h-5 w-5 ${
                (overview?.activePollingTasks || 0) > 0
                  ? 'text-[#DF7900]'
                  : 'text-[#4D627A]'
              }`}
            />
          </div>
          <div className="mt-3 flex items-baseline gap-2.5">
            <span className="font-mono text-3xl font-bold tabular-nums text-[#0D223D]">
              {overview?.activeSchedules ?? 0}
            </span>
            <span className="text-xs font-medium text-[#DF7900]">
              轮询寻座中 {overview?.activePollingTasks ?? 0}
            </span>
          </div>
          <p className="mt-1.5 text-xs text-[#64748B]">无座自动持续扫描直至成功锁定座位</p>
        </div>

        <div className="rounded-xl border border-[#DCE4EE] bg-white p-5">
          <div className="flex items-center justify-between text-[#4D627A]">
            <span className="text-sm font-medium">已认证师生账号</span>
            <Award className="h-5 w-5 text-[#DF7900]" />
          </div>
          <div className="mt-3 flex items-baseline gap-2.5">
            <span className="font-mono text-3xl font-bold tabular-nums text-[#0D223D]">
              {overview?.registeredUsers ?? 0}
            </span>
            <span className="text-xs text-[#4D627A]">覆盖 {areas.length} 个阅览区域</span>
          </div>
          <p className="mt-1.5 text-xs text-[#64748B]">统一经由 cas.dlufl.edu.cn 校验身份</p>
        </div>
      </section>

      {/* Areas Quick Grid + Live Recent Feed */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <section className="rounded-xl border border-[#DCE4EE] bg-white p-6 lg:col-span-7">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-[#0D223D]">开放阅览区域一览</h2>
              <p className="mt-0.5 text-xs text-[#4D627A]">
                点击任意区域直接查看该区座位占用网格并在线预约
              </p>
            </div>
            <Building2 className="h-5 w-5 text-[#0D386B]" />
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {areas.map((area) => {
              const count = areaCountMap.get(area.id) ?? 0;
              return (
                <button
                  key={area.id}
                  type="button"
                  onClick={() => onNavigate('seats', area.id)}
                  className="group rounded-xl border border-[#DCE4EE] bg-[#F8FAFC] p-4 text-left transition-colors hover:border-[#0D386B] hover:bg-white"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-[#0D223D] group-hover:text-[#0D386B]">
                      {area.name}
                    </span>
                    <span className="rounded bg-[#E7EEF7] px-2 py-0.5 font-mono text-xs font-medium text-[#0D386B]">
                      {area.floor}
                    </span>
                  </div>
                  <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-[#4D627A]">
                    {area.description}
                  </p>
                  <div className="mt-3 flex items-center justify-between border-t border-[#DCE4EE]/80 pt-2.5 text-xs text-[#4D627A]">
                    <span>开放 {area.openTime}–{area.closeTime}</span>
                    <span className="font-mono font-semibold tabular-nums text-[#0D386B]">
                      成功约座 {count} 次
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="rounded-xl border border-[#DCE4EE] bg-white p-6 lg:col-span-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-[#0D223D]">近期成功约座动态</h2>
              <p className="mt-0.5 text-xs text-[#4D627A]">最新入库的真实预约成功记录</p>
            </div>
            <Activity className="h-5 w-5 text-emerald-600" />
          </div>

          <div className="mt-4 space-y-2.5">
            {(overview?.recentSuccesses || []).length === 0 ? (
              <div className="rounded-lg border border-dashed border-[#CBD5E1] bg-[#F8FAFC] p-6 text-center text-sm text-[#4D627A]">
                暂无成功预约记录。登录后前往「区域选座」或「定时抢座」完成首次约座，统计将实时同步。
              </div>
            ) : (
              overview!.recentSuccesses.slice(0, 7).map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between rounded-lg border border-[#EEF2F6] bg-[#F8FAFC] px-3.5 py-2.5 text-xs"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-[#0D223D]">{item.studentName}</span>
                      <span className="truncate text-[#64748B]">{item.unitName}</span>
                    </div>
                    <p className="mt-0.5 text-[#4D627A]">
                      {item.areaName} · <span className="font-mono font-medium text-[#0D386B]">{item.seatName}</span>{' '}
                      ({item.targetDate} {item.startTime}-{item.endTime})
                    </p>
                  </div>
                  <span
                    className={`ml-2 shrink-0 rounded px-2 py-0.5 font-medium ${
                      item.source === 'polling'
                        ? 'bg-amber-50 text-amber-700'
                        : item.source === 'scheduled'
                          ? 'bg-blue-50 text-[#0D386B]'
                          : 'bg-emerald-50 text-emerald-700'
                    }`}
                  >
                    {sourceLabel(item.source)}
                  </span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
