import React, { useCallback, useEffect, useState } from 'react';
import {
  Award,
  CalendarDays,
  CreditCard,
  MapPin,
  Search,
  Sparkles,
  UserCheck,
} from 'lucide-react';
import { api } from '../api';
import type { LeaderboardCard, ReservationCard, UserProfile } from '../types';
import { DluflEmblem } from './DluflEmblem';

interface CardQueryPanelProps {
  user: UserProfile | null;
}

export const CardQueryPanel: React.FC<CardQueryPanelProps> = ({ user }) => {
  const [query, setQuery] = useState(user?.studentId || '');
  const [card, setCard] = useState<ReservationCard | null>(null);
  const [notFoundMsg, setNotFoundMsg] = useState<string | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardCard[]>([]);
  const [loading, setLoading] = useState(false);

  const runQuery = useCallback(async (q: string) => {
    setLoading(true);
    setNotFoundMsg(null);
    try {
      const res = await api.stats.queryCard(q);
      if (res.found && res.card) {
        setCard(res.card);
      } else {
        setCard(null);
        setNotFoundMsg(res.message || '未找到对应的预约卡片');
      }
    } catch (err: any) {
      setNotFoundMsg(err?.message || '查询失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadLeaderboard = useCallback(async () => {
    try {
      const res = await api.stats.leaderboard();
      setLeaderboard(res.cards);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void loadLeaderboard();
    if (user?.studentId) {
      setQuery(user.studentId);
      void runQuery(user.studentId);
    }
  }, [user?.studentId, loadLeaderboard, runQuery]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void runQuery(query);
  };

  return (
    <div className="space-y-6">
      {/* Search Bar */}
      <section className="rounded-2xl border border-[#DCE4EE] bg-white p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="text-lg font-bold text-[#0D223D]">卡片系统 · 成功预约次数查询</h2>
            <p className="mt-1 text-sm text-[#4D627A]">
              输入学号 / 校园一卡通号或姓名，查询个人图书馆座位预约凭证卡、累计成功约座次数与偏好区域分布。
            </p>
          </div>
          {user && (
            <button
              type="button"
              onClick={() => {
                setQuery(user.studentId);
                void runQuery(user.studentId);
              }}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[#0D386B]/25 bg-[#F3F6FA] px-3.5 py-2 text-xs font-semibold text-[#0D386B] hover:bg-[#E7EEF7]"
            >
              <UserCheck className="h-4 w-4" />
              查询我的卡片 ({user.studentId})
            </button>
          )}
        </div>

        <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-2.5 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-[#64748B]" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="输入学号 / 校园卡号或姓名（例如 2023041101）"
              className="w-full rounded-xl border border-[#CBD5E1] py-3 pr-4 pl-10 text-sm outline-none focus:border-[#0D386B] focus:ring-2 focus:ring-[#0D386B]/15"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="rounded-xl bg-[#0D386B] px-6 py-3 text-sm font-semibold text-white hover:bg-[#0A2C55] disabled:opacity-60"
          >
            {loading ? '查询中...' : '查询预约卡片'}
          </button>
        </form>
      </section>

      {notFoundMsg && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900">
          {notFoundMsg}
        </div>
      )}

      {/* Physical-Pass Styled Library Seat Card */}
      {card && (
        <section className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* Left: Embossed DLUFL Library Pass Card */}
          <div className="lg:col-span-5">
            <div className="relative overflow-hidden rounded-2xl bg-[#0D386B] p-6 text-white shadow-lg">
              {/* Subtle architectural emblem watermark */}
              <div className="pointer-events-none absolute -right-10 -bottom-10 opacity-10">
                <DluflEmblem className="h-52 w-52" />
              </div>

              {/* Top amber accent stripe */}
              <div className="absolute top-0 right-0 left-0 h-1.5 bg-[#DF7900]" />

              <div className="relative flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <DluflEmblem className="h-9 w-9" />
                  <div>
                    <p className="text-xs font-medium text-blue-100">大连外国语大学图书馆</p>
                    <p className="text-sm font-bold tracking-wide">座位预约统计凭证卡</p>
                  </div>
                </div>
                <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold text-amber-200">
                  <Award className="h-3.5 w-3.5" />
                  {card.cardTier.label}
                </span>
              </div>

              <div className="relative mt-7 grid grid-cols-2 items-end gap-4">
                <div>
                  <p className="text-xs text-blue-200">持卡人</p>
                  <p className="mt-1 text-2xl font-bold">{card.name}</p>
                  <p className="mt-1 font-mono text-sm tracking-wider text-blue-100">
                    {card.studentId}
                  </p>
                  <p className="mt-0.5 text-xs text-blue-200/85">{card.unitName}</p>
                </div>

                <div className="text-right">
                  <p className="text-xs text-blue-200">累计成功预约次数</p>
                  <p className="mt-1 font-mono text-5xl font-bold tabular-nums text-white">
                    {card.totalSuccess}
                  </p>
                  <p className="mt-1 text-xs text-amber-300">
                    本月 {card.thisMonthSuccess} 次 · 本周 {card.thisWeekSuccess} 次
                  </p>
                </div>
              </div>

              <div className="relative mt-6 grid grid-cols-3 gap-2 border-t border-white/15 pt-4 text-center">
                <div className="rounded-lg bg-white/10 px-2 py-2">
                  <p className="text-[11px] text-blue-200">手动选座</p>
                  <p className="mt-0.5 font-mono text-lg font-bold tabular-nums">
                    {card.manualSuccess}
                  </p>
                </div>
                <div className="rounded-lg bg-white/10 px-2 py-2">
                  <p className="text-[11px] text-blue-200">18:01 准点抢</p>
                  <p className="mt-0.5 font-mono text-lg font-bold tabular-nums">
                    {card.scheduledSuccess}
                  </p>
                </div>
                <div className="rounded-lg bg-white/10 px-2 py-2">
                  <p className="text-[11px] text-blue-200">轮询捡漏</p>
                  <p className="mt-0.5 font-mono text-lg font-bold tabular-nums text-amber-300">
                    {card.pollingSuccess}
                  </p>
                </div>
              </div>

              <div className="relative mt-4 flex items-center justify-between text-xs text-blue-200/90">
                <span>常去区域：{card.favoriteArea}</span>
                <span>累计到馆天数：{card.activeDays} 天</span>
              </div>
            </div>
          </div>

          {/* Right: Area Breakdown + Verified Booking Stamp List */}
          <div className="space-y-4 lg:col-span-7">
            <div className="rounded-xl border border-[#DCE4EE] bg-white p-5">
              <h3 className="text-sm font-semibold text-[#0D223D]">各阅览区域成功次数分布</h3>
              {card.areaBreakdown.length === 0 ? (
                <p className="mt-3 text-xs text-[#64748B]">该卡片暂无区域分布数据。</p>
              ) : (
                <div className="mt-3 space-y-2.5">
                  {card.areaBreakdown.map((item) => {
                    const pct =
                      card.totalSuccess > 0
                        ? Math.max(8, Math.round((item.count / card.totalSuccess) * 100))
                        : 0;
                    return (
                      <div key={item.areaId}>
                        <div className="mb-1 flex justify-between text-xs">
                          <span className="font-medium text-[#0D223D]">{item.areaName}</span>
                          <span className="font-mono font-semibold text-[#0D386B]">
                            {item.count} 次 ({pct}%)
                          </span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-[#EEF2F6]">
                          <div
                            style={{ width: `${pct}%` }}
                            className="h-full rounded-full bg-[#0D386B]"
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-[#DCE4EE] bg-white p-5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-[#0D223D]">近期成功预约凭证记录</h3>
                <span className="text-xs text-[#64748B]">成功率 {card.successRate}%</span>
              </div>
              {card.recentRecords.length === 0 ? (
                <p className="mt-3 text-xs text-[#64748B]">暂无成功预约明细。</p>
              ) : (
                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {card.recentRecords.map((rec) => (
                    <div
                      key={rec.id}
                      className="rounded-lg border border-[#EEF2F6] bg-[#F8FAFC] p-3 text-xs"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-[#0D223D]">{rec.areaName}</span>
                        <span className="font-mono font-bold text-[#0D386B]">{rec.seatName}</span>
                      </div>
                      <div className="mt-1.5 flex items-center justify-between text-[#4D627A]">
                        <span className="inline-flex items-center gap-1 font-mono">
                          <CalendarDays className="h-3.5 w-3.5" />
                          {rec.targetDate} {rec.startTime}-{rec.endTime}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Card Wall / Leaderboard */}
      <section className="rounded-xl border border-[#DCE4EE] bg-white p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-[#0D223D]">全馆预约成就卡片墙</h3>
            <p className="mt-0.5 text-xs text-[#4D627A]">
              点击任意卡片即可查看该持卡人的详细成功预约次数与历史分布
            </p>
          </div>
          <CreditCard className="h-5 w-5 text-[#0D386B]" />
        </div>

        {leaderboard.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-[#CBD5E1] bg-[#F8FAFC] p-8 text-center text-sm text-[#4D627A]">
            当前尚无上墙预约卡片。完成一次座位预约后，您的专属凭证卡将自动生成并展示于此。
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {leaderboard.map((item) => (
              <button
                key={item.rawQueryKey}
                type="button"
                onClick={() => {
                  setQuery(item.rawQueryKey);
                  void runQuery(item.rawQueryKey);
                }}
                className="group rounded-xl border border-[#DCE4EE] bg-[#F8FAFC] p-4 text-left transition-colors hover:border-[#0D386B] hover:bg-white"
              >
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#0D223D]">
                    <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-[#0D386B] font-mono text-[11px] font-bold text-white">
                      {item.rank}
                    </span>
                    {item.name}
                  </span>
                  <span className="rounded bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-[#B45309]">
                    {item.tier.label}
                  </span>
                </div>
                <p className="mt-1 font-mono text-xs text-[#64748B]">
                  {item.studentId} · {item.unitName}
                </p>
                <div className="mt-3 flex items-end justify-between border-t border-[#DCE4EE]/80 pt-2.5">
                  <div className="text-xs text-[#4D627A]">
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="h-3.5 w-3.5 text-[#0D386B]" />
                      最近：{item.lastArea} {item.lastSeat}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="font-mono text-xl font-bold tabular-nums text-[#0D386B]">
                      {item.totalSuccess}
                    </span>
                    <span className="ml-1 text-xs text-[#64748B]">次</span>
                  </div>
                </div>
                {item.autoSuccess > 0 && (
                  <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-emerald-700">
                    <Sparkles className="h-3 w-3" />
                    其中自动/轮询抢座成功 {item.autoSuccess} 次
                  </p>
                )}
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
