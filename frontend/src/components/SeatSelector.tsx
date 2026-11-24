import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  Clock,
  Grid3X3,
  KeyRound,
  Map as MapIcon,
  Radio,
  RefreshCw,
  Search,
  Server,
  Sparkles,
  Square,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { api } from '../api';
import type {
  LibraryArea,
  ScheduledTask,
  SeatInfo,
  SeatsResponse,
  UserProfile,
} from '../types';
import { SeatFloorMap } from './SeatFloorMap';

interface SeatSelectorProps {
  areas: LibraryArea[];
  initialAreaId?: string;
  user: UserProfile | null;
  onOpenLogin: () => void;
  onOpenBind: () => void;
  onBookedSuccess: () => Promise<void>;
  onJumpToScheduler: (preset: {
    areaId: string;
    seatNumber: number;
    startTime: string;
    endTime: string;
  }) => void;
}

function formatDateOffset(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const TIME_PRESETS = [
  { label: '全天', start: '08:30', end: '22:00' },
  { label: '上午', start: '08:30', end: '12:00' },
  { label: '下午', start: '13:30', end: '18:00' },
  { label: '晚间', start: '18:00', end: '22:00' },
];

export const SeatSelector: React.FC<SeatSelectorProps> = ({
  areas,
  initialAreaId,
  user,
  onOpenLogin,
  onOpenBind,
  onBookedSuccess,
  onJumpToScheduler,
}) => {
  const [areaId, setAreaId] = useState(initialAreaId || areas[1]?.id || '100475787');
  // 18:00 后默认展示刚放出的明日批次；18:00 前默认展示今日已开放批次
  const [date, setDate] = useState(() => formatDateOffset(new Date().getHours() >= 18 ? 1 : 0));
  const [startTime, setStartTime] = useState('08:30');
  const [endTime, setEndTime] = useState('22:00');
  const [filterStatus, setFilterStatus] = useState<'all' | 'free' | 'partial' | 'available'>('all');
  const [seatKeyword, setSeatKeyword] = useState('');

  // 视图模式：真实坐标平面位置图 / 网格列表
  const [viewMode, setViewMode] = useState<'map' | 'grid'>('map');
  const [mapZoom, setMapZoom] = useState<number>(1);

  const [data, setData] = useState<SeatsResponse | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const reqSeqRef = useRef(0);

  const [selectedSeat, setSelectedSeat] = useState<SeatInfo | null>(null);
  const [bookStart, setBookStart] = useState('08:30');
  const [bookEnd, setBookEnd] = useState('22:00');
  const [booking, setBooking] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null,
  );

  // 真正的「服务器端后台轮询抢座」状态（约座完全由 NestJS 服务器完成，关网页照常继续！）
  const [pollIntervalSec, setPollIntervalSec] = useState(10);
  const [pollAllowPartial, setPollAllowPartial] = useState(true);
  const [pollLockSeat, setPollLockSeat] = useState(false);
  const [serverTasks, setServerTasks] = useState<ScheduledTask[]>([]);
  const [serverActionBusy, setServerActionBusy] = useState(false);
  const prevPollingIdsRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (initialAreaId) setAreaId(initialAreaId);
  }, [initialAreaId]);

  useEffect(() => {
    setMapZoom(1);
  }, [areaId]);

  const handleSelectSeatFromMap = useCallback((seat: SeatInfo) => {
    setSelectedSeat(seat);
    setFeedback(null);
  }, []);

  const loadSeats = useCallback(async (): Promise<SeatsResponse | null> => {
    const seq = ++reqSeqRef.current;
    setRefreshing(true);
    setError(null);
    try {
      const res = await api.library.seats({ areaId, date, startTime, endTime });
      if (seq !== reqSeqRef.current) return null;
      setData(res);
      setLastUpdated(
        new Date().toLocaleTimeString('zh-CN', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
      );
      setSelectedSeat((prev) => {
        if (!prev) {
          return (
            res.seats.find((s) => s.status === 'free') ||
            res.seats.find((s) => s.status === 'partial') ||
            res.seats[0] ||
            null
          );
        }
        return res.seats.find((s) => s.devId === prev.devId) || res.seats[0] || null;
      });
      return res;
    } catch (err: any) {
      if (seq !== reqSeqRef.current) return null;
      setError(err?.message || '加载座位状态失败');
      return null;
    } finally {
      if (seq === reqSeqRef.current) {
        setRefreshing(false);
      }
    }
  }, [areaId, date, startTime, endTime]);

  const syncServerTasks = useCallback(async () => {
    if (!user) {
      setServerTasks([]);
      return;
    }
    try {
      const res = await api.library.schedules();
      // 检测是否有正在轮询的服务器端任务刚刚成功约上
      for (const t of res.tasks) {
        if (prevPollingIdsRef.current.has(t.id) && t.status === 'succeeded') {
          setFeedback({
            type: 'success',
            text: `服务器端后台轮询已成功约上：${t.lastMessage || t.lastSeatName || '已锁定座位'}`,
          });
          void loadSeats();
          void onBookedSuccess();
        }
      }
      prevPollingIdsRef.current = new Set(
        res.tasks.filter((t) => t.status === 'polling').map((t) => t.id),
      );
      setServerTasks(res.tasks);
    } catch {
      // ignore transient sync errors
    }
  }, [user, loadSeats, onBookedSuccess]);

  useEffect(() => {
    void loadSeats();
  }, [loadSeats]);

  useEffect(() => {
    void syncServerTasks();
  }, [syncServerTasks]);

  // 静默 AJAX 定时刷新座位显示（仅用于界面展示，不承担抢座逻辑）
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => {
      void loadSeats();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, loadSeats]);

  const activeServerTask = useMemo(() => {
    return (
      serverTasks.find(
        (t) =>
          t.status === 'polling' &&
          t.areaIds.includes(areaId) &&
          (!t.activeTargetDate || t.activeTargetDate === date),
      ) ||
      serverTasks.find((t) => t.status === 'polling') ||
      null
    );
  }, [serverTasks, areaId, date]);

  // 当存在服务器端后台轮询任务时，每 5 秒同步一次服务器进度展示（关掉网页服务器照常继续约座）
  useEffect(() => {
    if (!user || !activeServerTask) return;
    const timer = window.setInterval(() => {
      void syncServerTasks();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [user, activeServerTask, syncServerTasks]);

  useEffect(() => {
    if (selectedSeat?.longestFreeSlot) {
      setBookStart(selectedSeat.longestFreeSlot.startStr);
      setBookEnd(selectedSeat.longestFreeSlot.endStr);
    } else {
      setBookStart(data?.effectiveStartTime || startTime);
      setBookEnd(data?.effectiveEndTime || endTime);
    }
  }, [selectedSeat, data?.effectiveStartTime, data?.effectiveEndTime, startTime, endTime]);

  const matchedSeatIds = useMemo(() => {
    const seats = data?.seats || [];
    const set = new Set<string>();
    for (const s of seats) {
      if (filterStatus === 'free' && s.status !== 'free') continue;
      if (filterStatus === 'partial' && s.status !== 'partial') continue;
      if (filterStatus === 'available' && s.status !== 'free' && s.status !== 'partial') continue;
      if (seatKeyword.trim()) {
        const kw = seatKeyword.trim().toLowerCase();
        if (!s.devName.toLowerCase().includes(kw) && !String(s.seatNumber).includes(kw)) {
          continue;
        }
      }
      set.add(s.devId);
    }
    return set;
  }, [data, filterStatus, seatKeyword]);

  const filteredSeats = useMemo(() => {
    return (data?.seats || []).filter((s) => matchedSeatIds.has(s.devId));
  }, [data, matchedSeatIds]);

  const canShowMap = Boolean(data?.hasCoordinates && (data?.seats?.length ?? 0) > 0);
  const effectiveViewMode = viewMode === 'map' && canShowMap ? 'map' : 'grid';

  // 启动/停止真正的「服务器端后台轮询找座」
  const handleToggleServerPolling = async () => {
    if (!user) {
      onOpenLogin();
      return;
    }
    if (!user.icspaceBound) {
      onOpenBind();
      return;
    }

    setServerActionBusy(true);
    setError(null);
    setFeedback(null);

    try {
      if (activeServerTask) {
        await api.library.stopSchedule(activeServerTask.id);
        setFeedback({ type: 'success', text: '已通知服务器停止本轮后台轮询找座。' });
        await syncServerTasks();
        return;
      }

      const areaName = areas.find((a) => a.id === areaId)?.name || areaId;
      const taskName =
        pollLockSeat && selectedSeat
          ? `[实时盯座] ${areaName} ${selectedSeat.devName}`
          : `[实时盯座] ${areaName}`;

      // 优先复用已有的同名非周期盯座任务，避免重复占用单用户 5 个任务配额
      const reusable = serverTasks.find(
        (t) => !t.isRecurring && t.name.startsWith('[实时盯座]') && t.status !== 'polling',
      );

      const payload = {
        name: taskName,
        areaIds: [areaId],
        preferredSeats: pollLockSeat && selectedSeat ? [selectedSeat.seatNumber] : [],
        seatMin: pollLockSeat && selectedSeat ? selectedSeat.seatNumber : 1,
        seatMax: pollLockSeat && selectedSeat ? selectedSeat.seatNumber : 500,
        startTime,
        endTime,
        minFreeRate: pollAllowPartial ? 20 : 95,
        forceFullRange: !pollAllowPartial,
        triggerTime: '18:01',
        targetDayOffset: date === formatDateOffset(0) ? 0 : 1,
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        isRecurring: false,
        pollIntervalSec: Math.max(5, Math.min(60, pollIntervalSec)),
        maxPollMinutes: 0, // 服务器端持续轮询直到约上
        enabled: true,
      };

      let taskId: number;
      if (reusable) {
        const updated = await api.library.updateSchedule(reusable.id, payload);
        taskId = updated.task.id;
      } else {
        const created = await api.library.createSchedule(payload);
        taskId = created.task.id;
      }

      const triggered = await api.library.triggerSchedule(taskId, date);
      await syncServerTasks();

      if (triggered.task.status === 'succeeded') {
        setFeedback({
          type: 'success',
          text: `服务器端立即约上成功：${triggered.task.lastMessage}`,
        });
        await Promise.all([loadSeats(), onBookedSuccess()]);
      } else {
        setFeedback({
          type: 'success',
          text: `已交由服务器端后台持续轮询（每 ${payload.pollIntervalSec} 秒扫描一次），关闭本网页或手机锁屏均会继续抢座直到约上！`,
        });
      }
    } catch (err: any) {
      setError(err?.message || '操作服务器端轮询失败');
    } finally {
      setServerActionBusy(false);
    }
  };

  const handleBook = async () => {
    if (!selectedSeat) return;
    if (!user) {
      onOpenLogin();
      return;
    }
    if (!user.icspaceBound) {
      onOpenBind();
      return;
    }
    setBooking(true);
    setFeedback(null);
    try {
      const res = await api.library.reserve({
        areaId: selectedSeat.areaId,
        devId: selectedSeat.devId,
        seatName: selectedSeat.devName,
        targetDate: date,
        startTime: bookStart,
        endTime: bookEnd,
      });
      setFeedback({ type: 'success', text: res.message });
      await Promise.all([loadSeats(), onBookedSuccess()]);
    } catch (err: any) {
      setFeedback({ type: 'error', text: err?.message || '预约失败' });
    } finally {
      setBooking(false);
    }
  };

  const todayStr = formatDateOffset(0);
  const tomorrowStr = formatDateOffset(1);
  const noFullSeat = Boolean(
    data && data.summary.total > 0 && data.summary.free === 0 && data.summary.unreleased === 0,
  );
  const noAvailableSeat = Boolean(
    data &&
      data.summary.total > 0 &&
      data.summary.free === 0 &&
      data.summary.partial === 0 &&
      data.summary.unreleased === 0,
  );

  return (
    <div className="space-y-5">
      {/* Area Switcher Bar */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {areas.map((area) => {
          const active = area.id === areaId;
          return (
            <button
              key={area.id}
              type="button"
              onClick={() => {
                setAreaId(area.id);
                setFeedback(null);
              }}
              className={`rounded-xl border px-4 py-3.5 text-left transition-colors ${
                active
                  ? 'border-[#0D386B] bg-[#0D386B] text-white'
                  : 'border-[#DCE4EE] bg-white text-[#0D223D] hover:border-[#0D386B]/50'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">{area.name}</span>
                <span
                  className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${
                    active ? 'bg-white/15 text-blue-100' : 'bg-[#F3F6FA] text-[#4D627A]'
                  }`}
                >
                  {area.floor}
                </span>
              </div>
              <p
                className={`mt-1 truncate text-xs ${
                  active ? 'text-blue-100/85' : 'text-[#64748B]'
                }`}
              >
                ID {area.id} · {area.openTime}–{area.closeTime}
              </p>
            </button>
          );
        })}
      </div>

      {/* Filters & Time Controls */}
      <div className="rounded-xl border border-[#DCE4EE] bg-white p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setDate(todayStr)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                date === todayStr
                  ? 'bg-[#0D386B] text-white'
                  : 'border border-[#DCE4EE] bg-[#F8FAFC] text-[#4D627A] hover:text-[#0D223D]'
              }`}
            >
              今天 ({todayStr.slice(5)})
            </button>
            <button
              type="button"
              onClick={() => setDate(tomorrowStr)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                date === tomorrowStr
                  ? 'bg-[#0D386B] text-white'
                  : 'border border-[#DCE4EE] bg-[#F8FAFC] text-[#4D627A] hover:text-[#0D223D]'
              }`}
            >
              明天 ({tomorrowStr.slice(5)})
            </button>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="rounded-lg border border-[#CBD5E1] px-2.5 py-1.5 font-mono text-xs text-[#0D223D]"
            />
          </div>

          <div className="flex items-center gap-1.5">
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="rounded-lg border border-[#CBD5E1] px-2.5 py-1.5 font-mono text-xs text-[#0D223D]"
            />
            <span className="text-xs text-[#64748B]">至</span>
            <input
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              className="rounded-lg border border-[#CBD5E1] px-2.5 py-1.5 font-mono text-xs text-[#0D223D]"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1">
            {TIME_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  setStartTime(p.start);
                  setEndTime(p.end);
                }}
                className="rounded-md border border-[#DCE4EE] bg-[#F8FAFC] px-2.5 py-1 text-xs text-[#4D627A] hover:border-[#0D386B] hover:text-[#0D386B]"
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-[#64748B]" />
              <input
                type="text"
                value={seatKeyword}
                onChange={(e) => setSeatKeyword(e.target.value)}
                placeholder="搜座位号"
                className="w-28 rounded-lg border border-[#CBD5E1] py-1.5 pr-2.5 pl-8 text-xs outline-none focus:border-[#0D386B]"
              />
            </div>

            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as any)}
              className="rounded-lg border border-[#CBD5E1] bg-white px-2.5 py-1.5 text-xs text-[#0D223D]"
            >
              <option value="all">全部座位</option>
              <option value="available">所有可约（全时段+部分时段）</option>
              <option value="free">仅全时段可约</option>
              <option value="partial">部分时段可约</option>
            </select>

            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#DCE4EE] bg-[#F8FAFC] px-2.5 py-1.5 text-xs text-[#4D627A]">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="accent-[#0D386B]"
              />
              自动刷新
            </label>

            <button
              type="button"
              onClick={() => void loadSeats()}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#DCE4EE] bg-[#F8FAFC] px-3 py-1.5 text-xs font-medium text-[#0D223D] hover:bg-[#E7EEF7]"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              刷新
            </button>
          </div>
        </div>

        {/* Calibrated Time Notice + Legend */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#EEF2F6] pt-3 text-xs">
          <div className="flex flex-wrap items-center gap-4 text-[#4D627A]">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-sm border border-emerald-300 bg-emerald-100" />
              全时段可约（{data?.summary.free ?? 0}）
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-sm border border-amber-300 bg-amber-100" />
              部分时段可约（{data?.summary.partial ?? 0}）
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-sm border border-slate-200 bg-slate-100" />
              已占满（{data?.summary.occupied ?? 0}）
            </span>
            {(data?.summary.unreleased ?? 0) > 0 && (
              <span className="inline-flex items-center gap-1.5 font-medium text-[#0D386B]">
                <span className="h-3 w-3 rounded-sm border border-dashed border-[#94A3B8] bg-[#EEF2F6]" />
                未放座（{data?.summary.unreleased ?? 0}）
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3 font-mono text-[#64748B]">
            {data?.timeCalibrated && data.effectiveStartTime && (
              <span className="inline-flex items-center gap-1 rounded bg-[#E7EEF7] px-2 py-0.5 text-[#0D386B]">
                <Clock className="h-3 w-3" />
                已校准可约时段 {data.effectiveStartTime}–{data.effectiveEndTime}
              </span>
            )}
            <span>
              共 {data?.summary.total ?? 0} 席 · {data?.isLive ? '实时 ICSpace 数据' : '本地/未授权视图'}
            </span>
          </div>
        </div>

        {/* Quick Partial-Slot Hint */}
        {noFullSeat && (data?.summary.partial ?? 0) > 0 && filterStatus !== 'partial' && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2 text-xs text-amber-900">
            <span>
              当前所选整段时段暂无全空座位，但本区有{' '}
              <strong className="font-mono">{data?.summary.partial}</strong> 个座位处于「部分时段可约」（已校准可从当前空闲区间内起约）。
            </span>
            <button
              type="button"
              onClick={() => setFilterStatus('partial')}
              className="rounded-md bg-[#DF7900] px-2.5 py-1 font-semibold text-white hover:bg-[#C66B00]"
            >
              筛选部分时段可约
            </button>
          </div>
        )}
      </div>

      {/* 100% Server-Side Polling Auto-Book Bar */}
      <div
        className={`rounded-xl border px-4 py-3.5 transition-colors ${
          activeServerTask
            ? 'border-[#DF7900] bg-[#FFF7ED]'
            : noAvailableSeat
              ? 'border-[#0D386B]/35 bg-[#EFF5FC]'
              : 'border-[#DCE4EE] bg-white'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-2.5">
            {activeServerTask ? (
              <Radio className="polling-dot mt-0.5 h-4 w-4 shrink-0 text-[#DF7900]" />
            ) : (
              <Server className="mt-0.5 h-4 w-4 shrink-0 text-[#0D386B]" />
            )}
            <div>
              <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-[#0D223D]">
                <span>服务器端后台轮询抢座（关网页 / 手机锁屏仍继续约座）</span>
                {activeServerTask && (
                  <span className="rounded-full bg-[#DF7900] px-2 py-0.5 font-mono text-[11px] font-semibold text-white">
                    服务端轮询中 · 第 {activeServerTask.pollAttempts} 次
                  </span>
                )}
                {!activeServerTask && noAvailableSeat && (
                  <span className="rounded-full bg-[#0D386B] px-2 py-0.5 text-[11px] font-medium text-white">
                    当前无空位 · 建议交由服务端盯座
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-[#4D627A]">
                {activeServerTask
                  ? `${activeServerTask.name}（目标 ${activeServerTask.activeTargetDate || date}）：${activeServerTask.lastMessage || '服务器正在持续扫描空位...'}`
                  : '由后端 NestJS 调度引擎持续执行查座、时间校准与自动提交预约（不依赖浏览器在线），直到成功约上座位。'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs">
            <div className="flex items-center gap-2 rounded-lg border border-[#DCE4EE] bg-white px-2.5 py-1.5">
              <span className="text-[#4D627A]">轮询间隔</span>
              <input
                type="range"
                min={5}
                max={60}
                step={5}
                value={pollIntervalSec}
                onChange={(e) => setPollIntervalSec(Number(e.target.value))}
                disabled={Boolean(activeServerTask) || serverActionBusy}
                className="w-24 accent-[#0D386B] disabled:opacity-60"
                aria-label="服务器端轮询间隔（5到60秒）"
              />
              <span className="w-8 text-right font-mono font-semibold text-[#0D386B]">
                {pollIntervalSec}s
              </span>
            </div>

            <label className="inline-flex cursor-pointer items-center gap-1.5 text-[#0D223D]">
              <input
                type="checkbox"
                checked={pollAllowPartial}
                onChange={(e) => setPollAllowPartial(e.target.checked)}
                disabled={Boolean(activeServerTask) || serverActionBusy}
                className="accent-[#0D386B]"
              />
              含部分时段可约
            </label>

            {selectedSeat && (
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-[#0D223D]">
                <input
                  type="checkbox"
                  checked={pollLockSeat}
                  onChange={(e) => setPollLockSeat(e.target.checked)}
                  disabled={Boolean(activeServerTask) || serverActionBusy}
                  className="accent-[#0D386B]"
                />
                仅盯 {selectedSeat.devName}
              </label>
            )}

            <button
              type="button"
              onClick={handleToggleServerPolling}
              disabled={serverActionBusy}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold text-white disabled:opacity-60 ${
                activeServerTask
                  ? 'bg-[#B45309] hover:bg-[#92400E]'
                  : 'bg-[#0D386B] hover:bg-[#0A2C55]'
              }`}
            >
              {activeServerTask ? (
                <>
                  <Square className="h-3.5 w-3.5" />
                  停止服务端轮询
                </>
              ) : (
                <>
                  <Server className="h-3.5 w-3.5" />
                  开启服务端轮询找座
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {data?.notice && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0 text-[#DF7900]" />
            <span>{data.notice}</span>
          </div>
          {!user ? (
            <button
              type="button"
              onClick={onOpenLogin}
              className="rounded-lg bg-[#0D386B] px-3 py-1.5 text-xs font-semibold text-white"
            >
              去 CAS 登录
            </button>
          ) : !user.icspaceBound ? (
            <button
              type="button"
              onClick={onOpenBind}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#0D386B] px-3 py-1.5 text-xs font-semibold text-white"
            >
              <KeyRound className="h-3.5 w-3.5" />
              授权图书馆 ICSpace
            </button>
          ) : null}
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Main Split: Spatial Floor-Plan / Grid + Right Inspector */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="rounded-xl border border-[#DCE4EE] bg-white p-5 lg:col-span-8">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-semibold text-[#0D223D]">
                {data?.area.name || '阅览区'} 座位分布图
              </h3>
              <div className="inline-flex rounded-lg border border-[#DCE4EE] bg-[#F8FAFC] p-0.5 text-xs">
                <button
                  type="button"
                  disabled={!canShowMap}
                  onClick={() => setViewMode('map')}
                  className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 font-medium transition-colors disabled:opacity-40 ${
                    effectiveViewMode === 'map'
                      ? 'bg-[#0D386B] text-white'
                      : 'text-[#4D627A] hover:text-[#0D223D]'
                  }`}
                >
                  <MapIcon className="h-3.5 w-3.5" />
                  对应位置图
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('grid')}
                  className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 font-medium transition-colors ${
                    effectiveViewMode === 'grid'
                      ? 'bg-[#0D386B] text-white'
                      : 'text-[#4D627A] hover:text-[#0D223D]'
                  }`}
                >
                  <Grid3X3 className="h-3.5 w-3.5" />
                  列表网格
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {effectiveViewMode === 'map' && (
                <div className="inline-flex items-center gap-1 rounded-lg border border-[#DCE4EE] bg-[#F8FAFC] px-1.5 py-0.5 text-xs text-[#4D627A]">
                  <button
                    type="button"
                    onClick={() => setMapZoom((z) => Math.max(1, Number((z - 0.35).toFixed(2))))}
                    disabled={mapZoom <= 1}
                    className="rounded p-1 hover:bg-white disabled:opacity-40"
                    title="缩小平面图"
                  >
                    <ZoomOut className="h-3.5 w-3.5" />
                  </button>
                  <span className="w-10 text-center font-mono text-[11px]">
                    {Math.round(mapZoom * 100)}%
                  </span>
                  <button
                    type="button"
                    onClick={() => setMapZoom((z) => Math.min(2.4, Number((z + 0.35).toFixed(2))))}
                    disabled={mapZoom >= 2.4}
                    className="rounded p-1 hover:bg-white disabled:opacity-40"
                    title="放大平面图"
                  >
                    <ZoomIn className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}

              <span className="font-mono text-xs text-[#64748B]">
                {refreshing
                  ? '正在同步最新座位...'
                  : lastUpdated
                    ? `上次同步 ${lastUpdated}`
                    : '点击座位查看空闲时段'}
              </span>
            </div>
          </div>

          {(data?.seats?.length ?? 0) === 0 ? (
            <div className="rounded-xl border border-dashed border-[#CBD5E1] bg-[#F8FAFC] py-14 text-center text-sm text-[#4D627A]">
              {refreshing && !data
                ? '正在获取该区域座位列表...'
                : '当前暂未加载到座位数据，请确认已完成授权或稍后刷新。'}
            </div>
          ) : effectiveViewMode === 'map' ? (
            /* 真实对应位置平面座位图（独立 memo 渲染 + 客户端 Blob 缓存 + 后台预热） */
            <SeatFloorMap
              areaName={data?.area.name || '阅览区'}
              floorPlanUrl={data?.floorPlanUrl || null}
              areas={areas}
              seats={data?.seats || []}
              matchedSeatIds={matchedSeatIds}
              selectedDevId={selectedSeat?.devId || null}
              mapZoom={mapZoom}
              onSelectSeat={handleSelectSeatFromMap}
            />
          ) : filteredSeats.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[#CBD5E1] bg-[#F8FAFC] py-14 text-center text-sm text-[#4D627A]">
              当前筛选条件下没有可显示的座位，可切换筛选或开启上方「服务端轮询找座」。
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8">
              {filteredSeats.map((seat) => {
                const isSelected = selectedSeat?.devId === seat.devId;
                const statusClass =
                  seat.status === 'free'
                    ? 'border-emerald-300 bg-emerald-50/70 text-emerald-900 hover:border-emerald-500'
                    : seat.status === 'partial'
                      ? 'border-amber-300 bg-amber-50/70 text-amber-900 hover:border-amber-500'
                      : seat.status === 'unreleased'
                        ? 'border-dashed border-[#CBD5E1] bg-[#F1F5F9] text-[#64748B] hover:border-[#0D386B]/50'
                        : 'border-slate-200 bg-slate-100/80 text-slate-400 hover:border-slate-300';

                return (
                  <button
                    key={seat.devId}
                    type="button"
                    onClick={() => {
                      setSelectedSeat(seat);
                      setFeedback(null);
                    }}
                    className={`relative flex flex-col items-center justify-center rounded-lg border px-1.5 py-2.5 transition-all ${statusClass} ${
                      isSelected ? 'ring-2 ring-[#0D386B] ring-offset-1' : ''
                    }`}
                  >
                    <span className="font-mono text-xs font-bold tabular-nums">
                      {String(seat.seatNumber).padStart(3, '0')}
                    </span>
                    <span className="mt-1 text-[10px] leading-tight opacity-85">
                      {seat.status === 'free'
                        ? '全时段可约'
                        : seat.status === 'partial'
                          ? '部分可约'
                          : seat.status === 'unreleased'
                            ? '未放座'
                            : '已满'}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Right Seat Detail & Booking Panel */}
        <div className="rounded-xl border border-[#DCE4EE] bg-white p-5 lg:col-span-4">
          <h3 className="text-sm font-semibold text-[#0D223D]">座位详情与快速预约</h3>

          {!selectedSeat ? (
            <p className="mt-6 text-sm text-[#64748B]">请在左侧座位图中选择一个座位。</p>
          ) : (
            <div className="mt-4 space-y-4">
              <div className="rounded-xl border border-[#DCE4EE] bg-[#F8FAFC] p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-[#4D627A]">{selectedSeat.areaName}</p>
                    <p className="mt-0.5 font-mono text-xl font-bold text-[#0D386B]">
                      {selectedSeat.devName}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                      selectedSeat.status === 'free'
                        ? 'bg-emerald-100 text-emerald-800'
                        : selectedSeat.status === 'partial'
                          ? 'bg-amber-100 text-amber-800'
                          : selectedSeat.status === 'unreleased'
                            ? 'bg-slate-200 text-[#0D386B]'
                            : 'bg-slate-200 text-slate-600'
                    }`}
                  >
                    {selectedSeat.status === 'free'
                      ? '全时段可约'
                      : selectedSeat.status === 'partial'
                        ? `部分时段可约 (${selectedSeat.freeRate}%)`
                        : selectedSeat.status === 'unreleased'
                          ? '该批次未放座'
                          : '该时段已约满'}
                  </span>
                </div>

                {/* 08:00-22:00 visual occupancy bar */}
                <div className="mt-4">
                  <div className="mb-1 flex justify-between font-mono text-[10px] text-[#64748B]">
                    <span>08:00</span>
                    <span>12:00</span>
                    <span>16:00</span>
                    <span>20:00</span>
                    <span>22:00</span>
                  </div>
                  <div
                    className={`relative h-3 w-full overflow-hidden rounded-full ${
                      selectedSeat.status === 'unreleased' ? 'bg-slate-200' : 'bg-emerald-200'
                    }`}
                  >
                    {selectedSeat.busySlots.map((slot, idx) => {
                      const dayStart = 8 * 60;
                      const daySpan = 14 * 60;
                      const left = Math.max(0, ((slot.start - dayStart) / daySpan) * 100);
                      const width = Math.min(
                        100 - left,
                        Math.max(2, ((slot.end - slot.start) / daySpan) * 100),
                      );
                      return (
                        <div
                          key={idx}
                          title={`已占用 ${slot.startStr}-${slot.endStr}`}
                          style={{ left: `${left}%`, width: `${width}%` }}
                          className="absolute top-0 bottom-0 bg-red-500/80"
                        />
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Free Slots */}
              <div>
                <p className="text-xs font-medium text-[#4D627A]">
                  校准后可用空闲时间段（点击填入）
                </p>
                {selectedSeat.status === 'unreleased' ? (
                  <p className="mt-1.5 text-xs text-[#0D386B]">
                    {data?.batchStatus?.message ||
                      '该日期尚未开放预约，可点击下方按钮提前设为 18:01 自动抢座心仪座位。'}
                  </p>
                ) : selectedSeat.freeSlots.length === 0 ? (
                  <p className="mt-1.5 text-xs text-red-600">
                    当前校准时段内没有剩余空档，可开启上方「服务器端轮询找座」持续盯座。
                  </p>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {selectedSeat.freeSlots.map((slot, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => {
                          setBookStart(slot.startStr);
                          setBookEnd(slot.endStr);
                        }}
                        className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 font-mono text-xs font-medium text-emerald-800 hover:border-emerald-400"
                      >
                        {slot.startStr} – {slot.endStr}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Booking Time Inputs */}
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="mb-1 block text-xs font-medium text-[#4D627A]">预约开始</label>
                  <input
                    type="time"
                    value={bookStart}
                    onChange={(e) => setBookStart(e.target.value)}
                    className="w-full rounded-lg border border-[#CBD5E1] px-3 py-2 font-mono text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-[#4D627A]">预约结束</label>
                  <input
                    type="time"
                    value={bookEnd}
                    onChange={(e) => setBookEnd(e.target.value)}
                    className="w-full rounded-lg border border-[#CBD5E1] px-3 py-2 font-mono text-sm"
                  />
                </div>
              </div>

              {feedback && (
                <div
                  className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs ${
                    feedback.type === 'success'
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                      : 'border-red-200 bg-red-50 text-red-700'
                  }`}
                >
                  {feedback.type === 'success' ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  ) : (
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  )}
                  <span>{feedback.text}</span>
                </div>
              )}

              <button
                type="button"
                onClick={handleBook}
                disabled={
                  booking ||
                  selectedSeat.status === 'occupied' ||
                  selectedSeat.status === 'unreleased'
                }
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#0D386B] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#0A2C55] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Sparkles className="h-4 w-4" />
                {selectedSeat.status === 'unreleased'
                  ? '该批次尚未放座（请使用下方 18:01 自动抢座）'
                  : booking
                    ? '正在提交预约...'
                    : `确认预约 ${selectedSeat.devName}`}
              </button>

              <button
                type="button"
                onClick={() =>
                  onJumpToScheduler({
                    areaId: selectedSeat.areaId,
                    seatNumber: selectedSeat.seatNumber,
                    startTime: bookStart,
                    endTime: bookEnd,
                  })
                }
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-[#DCE4EE] bg-[#F8FAFC] px-4 py-2 text-xs font-semibold text-[#0D386B] hover:bg-[#E7EEF7]"
              >
                <CalendarClock className="h-4 w-4 text-[#DF7900]" />
                设为 18:01 定期抢座心仪座位
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
