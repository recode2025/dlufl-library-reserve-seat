import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Ban,
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
  SeatDetailResponse,
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

function parseTimeToMin(timeStr: string): number {
  const [h, m] = (timeStr || '').split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return 0;
  return h * 60 + m;
}

function formatMinToTime(minutes: number): string {
  const clamped = Math.max(0, Math.min(24 * 60, Math.round(minutes)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
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
  const [seatDetail, setSeatDetail] = useState<SeatDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailSeqRef = useRef(0);
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
  const [pollBlacklistText, setPollBlacklistText] = useState('');
  const [serverTasks, setServerTasks] = useState<ScheduledTask[]>([]);
  const [serverActionBusy, setServerActionBusy] = useState(false);
  const prevPollingIdsRef = useRef<Set<number>>(new Set());

  const pollExcludedSeats = useMemo(
    () =>
      Array.from(
        new Set(
          pollBlacklistText
            .split(/[,，\s]+/)
            .map((s) => parseInt(s, 10))
            .filter((n) => !Number.isNaN(n) && n > 0),
        ),
      ),
    [pollBlacklistText],
  );

  const toggleSeatBlacklist = useCallback((seatNumber: number) => {
    setPollBlacklistText((prev) => {
      const nums = Array.from(
        new Set(
          prev
            .split(/[,，\s]+/)
            .map((s) => parseInt(s, 10))
            .filter((n) => !Number.isNaN(n) && n > 0),
        ),
      );
      const next = nums.includes(seatNumber)
        ? nums.filter((n) => n !== seatNumber)
        : [...nums, seatNumber].sort((a, b) => a - b);
      return next.join(', ');
    });
  }, []);

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

  // 选中具体座位时，实时向后端请求该座位的真实可约起始/结束时间、开放时段与最新占用
  const loadSeatDetail = useCallback(
    async (devId: string, targetAreaId: string, targetDate: string) => {
      const seq = ++detailSeqRef.current;
      setDetailLoading(true);
      setDetailError(null);
      try {
        const res = await api.library.seatDetail({
          devId,
          areaId: targetAreaId,
          date: targetDate,
        });
        if (seq !== detailSeqRef.current) return;
        setSeatDetail(res);

        // 按该座位实时返回的真实可约区间与单次最长时长自动填入起止时间
        const bestSlot = res.seat.longestFreeSlot || res.seat.freeSlots[0] || null;
        if (bestSlot) {
          const maxDur = res.rule?.maxResvTime || 0;
          const clampedEnd =
            maxDur > 0 && bestSlot.end - bestSlot.start > maxDur
              ? formatMinToTime(bestSlot.start + maxDur)
              : bestSlot.endStr;
          setBookStart(bestSlot.startStr);
          setBookEnd(clampedEnd);
        } else {
          setBookStart(res.bookableStart || res.openStart);
          setBookEnd(res.bookableEnd || res.openEnd);
        }
      } catch (err: any) {
        if (seq !== detailSeqRef.current) return;
        setDetailError(err?.message || '拉取该座位实时可约时间失败');
      } finally {
        if (seq === detailSeqRef.current) {
          setDetailLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (!selectedSeat) {
      setSeatDetail(null);
      setDetailError(null);
      return;
    }
    // 先用已有列表数据做瞬时占位，紧接着发起该座位的实时请求覆盖为精确值
    if (selectedSeat.longestFreeSlot) {
      const maxDur = selectedSeat.rule?.maxResvTime || 0;
      const s = selectedSeat.longestFreeSlot;
      const clampedEnd =
        maxDur > 0 && s.end - s.start > maxDur ? formatMinToTime(s.start + maxDur) : s.endStr;
      setBookStart(s.startStr);
      setBookEnd(clampedEnd);
    } else {
      setBookStart(selectedSeat.openStart || data?.effectiveStartTime || startTime);
      setBookEnd(selectedSeat.openEnd || data?.effectiveEndTime || endTime);
    }
    void loadSeatDetail(selectedSeat.devId, selectedSeat.areaId, date);
  }, [
    selectedSeat?.devId,
    selectedSeat?.areaId,
    date,
    loadSeatDetail,
  ]);

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
        excludedSeats: pollLockSeat ? [] : pollExcludedSeats,
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
      await Promise.all([
        loadSeats(),
        loadSeatDetail(selectedSeat.devId, selectedSeat.areaId, date),
        onBookedSuccess(),
      ]);
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
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
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
              className={`min-w-0 rounded-xl border px-3 py-3 text-left transition-colors sm:px-4 sm:py-3.5 ${
                active
                  ? 'border-[#0D386B] bg-[#0D386B] text-white'
                  : 'border-[#DCE4EE] bg-white text-[#0D223D] hover:border-[#0D386B]/50'
              }`}
            >
              <div className="flex items-center justify-between gap-1.5">
                <span className="truncate text-sm font-semibold">{area.name}</span>
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] sm:text-[11px] ${
                    active ? 'bg-white/15 text-blue-100' : 'bg-[#F3F6FA] text-[#4D627A]'
                  }`}
                >
                  {area.floor}
                </span>
              </div>
              <p
                className={`mt-1 truncate text-[11px] sm:text-xs ${
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
      <div className="rounded-xl border border-[#DCE4EE] bg-white p-3.5 sm:p-4">
        <div className="flex flex-wrap items-center gap-2.5 sm:gap-3">
          <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto">
            <button
              type="button"
              onClick={() => setDate(todayStr)}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold sm:px-3 ${
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
              className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold sm:px-3 ${
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
              className="h-8 min-w-0 flex-1 rounded-lg border border-[#CBD5E1] bg-white px-2.5 py-1 font-mono text-xs text-[#0D223D] sm:flex-none"
            />
          </div>

          <div className="flex w-full items-center gap-1.5 sm:w-auto">
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="h-8 min-w-0 flex-1 rounded-lg border border-[#CBD5E1] bg-white px-2.5 py-1 font-mono text-xs text-[#0D223D] sm:w-24 sm:flex-none"
            />
            <span className="shrink-0 text-xs text-[#64748B]">至</span>
            <input
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              className="h-8 min-w-0 flex-1 rounded-lg border border-[#CBD5E1] bg-white px-2.5 py-1 font-mono text-xs text-[#0D223D] sm:w-24 sm:flex-none"
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

          <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
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
                  ? `${activeServerTask.name}（目标 ${activeServerTask.activeTargetDate || date}${
                      activeServerTask.excludedSeats?.length
                        ? ` · 排除黑名单 ${activeServerTask.excludedSeats.join(', ')}`
                        : ''
                    }）：${activeServerTask.lastMessage || '服务器正在持续扫描空位...'}`
                  : '由后端 NestJS 调度引擎持续执行查座、时间校准与自动提交预约（不依赖浏览器在线），直到成功约上座位。'}
              </p>
            </div>
          </div>

          <div className="flex w-full flex-wrap items-center gap-2.5 text-xs sm:w-auto sm:gap-3">
            <div className="flex w-full items-center justify-between gap-2 rounded-lg border border-[#DCE4EE] bg-white px-2.5 py-1.5 sm:w-auto">
              <span className="shrink-0 text-[#4D627A]">轮询间隔</span>
              <input
                type="range"
                min={5}
                max={60}
                step={5}
                value={pollIntervalSec}
                onChange={(e) => setPollIntervalSec(Number(e.target.value))}
                disabled={Boolean(activeServerTask) || serverActionBusy}
                className="min-w-0 flex-1 accent-[#0D386B] disabled:opacity-60 sm:w-24 sm:flex-none"
                aria-label="服务器端轮询间隔（5到60秒）"
              />
              <span className="w-8 shrink-0 text-right font-mono font-semibold text-[#0D386B]">
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

            {!pollLockSeat && (
              <div className="flex w-full items-center gap-1.5 rounded-lg border border-[#DCE4EE] bg-white px-2.5 py-1.5 sm:w-auto">
                <Ban className="h-3.5 w-3.5 shrink-0 text-rose-500" />
                <span className="shrink-0 text-[#4D627A]">黑名单</span>
                <input
                  type="text"
                  value={pollBlacklistText}
                  onChange={(e) => setPollBlacklistText(e.target.value)}
                  disabled={Boolean(activeServerTask) || serverActionBusy}
                  placeholder="排除座号如 1,5,18"
                  className="min-w-0 flex-1 bg-transparent font-mono text-xs text-[#0D223D] outline-none placeholder:text-[#94A3B8] disabled:opacity-60 sm:w-32 sm:flex-none"
                />
              </div>
            )}

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
              className={`inline-flex w-full items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold text-white disabled:opacity-60 sm:w-auto ${
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
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-[#0D223D]">座位详情与快速预约</h3>
            {selectedSeat && (
              <button
                type="button"
                onClick={() => void loadSeatDetail(selectedSeat.devId, selectedSeat.areaId, date)}
                disabled={detailLoading}
                className="inline-flex items-center gap-1 rounded-md border border-[#DCE4EE] bg-[#F8FAFC] px-2 py-1 text-[11px] font-medium text-[#4D627A] hover:border-[#0D386B] hover:text-[#0D386B] disabled:opacity-50"
                title="重新实时请求该座位的精确可约起止时间"
              >
                <RefreshCw className={`h-3 w-3 ${detailLoading ? 'animate-spin' : ''}`} />
                {detailLoading ? '实时拉取中...' : '实时查询该座'}
              </button>
            )}
          </div>

          {!selectedSeat ? (
            <p className="mt-6 text-sm text-[#64748B]">请在左侧座位图中选择一个座位。</p>
          ) : (
            (() => {
              const matchedDetail =
                seatDetail &&
                seatDetail.seat.devId === selectedSeat.devId &&
                seatDetail.targetDate === date
                  ? seatDetail
                  : null;
              const activeSeat = matchedDetail ? matchedDetail.seat : selectedSeat;
              const openStartStr = matchedDetail?.openStart || activeSeat.openStart || '08:00';
              const openEndStr = matchedDetail?.openEnd || activeSeat.openEnd || '22:00';
              const seatRule = matchedDetail?.rule || activeSeat.rule;
              const maxDurMin = seatRule?.maxResvTime || 0;
              const minDurMin = seatRule?.minResvTime || 30;
              const bookableStartStr =
                matchedDetail?.bookableStart ?? activeSeat.bookableStart ?? activeSeat.freeSlots[0]?.startStr ?? null;
              const bookableEndStr =
                matchedDetail?.bookableEnd ??
                activeSeat.bookableEnd ??
                (activeSeat.freeSlots.length > 0
                  ? activeSeat.freeSlots[activeSeat.freeSlots.length - 1].endStr
                  : null);

              const dayStart = parseTimeToMin(openStartStr);
              const dayEnd = Math.max(dayStart + 60, parseTimeToMin(openEndStr));
              const daySpan = dayEnd - dayStart;
              const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) =>
                formatMinToTime(dayStart + daySpan * ratio),
              );

              const toRangeStyle = (s: number, e: number, minWidthPct = 1) => {
                const cs = Math.max(dayStart, Math.min(dayEnd, s));
                const ce = Math.max(dayStart, Math.min(dayEnd, e));
                if (ce <= cs) return null;
                const left = ((cs - dayStart) / daySpan) * 100;
                const width = Math.min(
                  100 - left,
                  Math.max(minWidthPct, ((ce - cs) / daySpan) * 100),
                );
                return { left: `${left}%`, width: `${width}%` };
              };

              const selStartMin = parseTimeToMin(bookStart);
              const selEndMin = parseTimeToMin(bookEnd);
              const selStyle =
                activeSeat.status !== 'unreleased' && selEndMin > selStartMin
                  ? toRangeStyle(selStartMin, selEndMin, 1.5)
                  : null;
              const selConflictBusy =
                selEndMin > selStartMin &&
                activeSeat.busySlots.some((b) => b.start < selEndMin && b.end > selStartMin);
              const selOutOfOpen =
                selEndMin > selStartMin && (selStartMin < dayStart || selEndMin > dayEnd);
              const selOverMax =
                maxDurMin > 0 && selEndMin > selStartMin && selEndMin - selStartMin > maxDurMin;
              const selHasIssue = selConflictBusy || selOutOfOpen || selOverMax;

              // 根据用户当前选择的起点，实时计算该起点在该座位下最晚可约的结束时间
              const containingFreeSlot = activeSeat.freeSlots.find(
                (slot) => selStartMin >= slot.start && selStartMin < slot.end,
              );
              const suggestedMaxEndMin = containingFreeSlot
                ? maxDurMin > 0
                  ? Math.min(containingFreeSlot.end, selStartMin + maxDurMin)
                  : containingFreeSlot.end
                : null;
              const suggestedMaxEndStr =
                suggestedMaxEndMin && suggestedMaxEndMin > selStartMin
                  ? formatMinToTime(suggestedMaxEndMin)
                  : null;

              const pastEndMin =
                date === todayStr && data?.timeCalibrated && data?.effectiveStartTime
                  ? parseTimeToMin(data.effectiveStartTime)
                  : 0;
              const pastStyle =
                activeSeat.status !== 'unreleased' && pastEndMin > dayStart
                  ? toRangeStyle(dayStart, pastEndMin, 0.5)
                  : null;

              const openWindows = matchedDetail?.openWindows || activeSeat.openWindows || [];

              return (
                <div className="mt-4 space-y-4">
                  <div className="rounded-xl border border-[#DCE4EE] bg-[#F8FAFC] p-4">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="text-xs text-[#4D627A]">{activeSeat.areaName}</p>
                        <p className="mt-0.5 font-mono text-xl font-bold text-[#0D386B]">
                          {activeSeat.devName}
                        </p>
                      </div>
                      <span
                        className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                          activeSeat.status === 'free'
                            ? 'bg-emerald-100 text-emerald-800'
                            : activeSeat.status === 'partial'
                              ? 'bg-amber-100 text-amber-800'
                              : activeSeat.status === 'unreleased'
                                ? 'bg-slate-200 text-[#0D386B]'
                                : 'bg-slate-200 text-slate-600'
                        }`}
                      >
                        {activeSeat.status === 'free'
                          ? '全时段可约'
                          : activeSeat.status === 'partial'
                            ? `部分时段可约 (${activeSeat.freeRate}%)`
                            : activeSeat.status === 'unreleased'
                              ? '该批次未放座'
                              : '该时段已约满'}
                      </span>
                    </div>

                    {/* 该座位实时请求得到的真实开放起止与规则 */}
                    <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg border border-[#DCE4EE] bg-white px-3 py-2 text-[11px]">
                      <div>
                        <span className="text-[#64748B]">该座开放时段</span>
                        <div className="mt-0.5 font-mono font-semibold text-[#0D223D]">
                          {openStartStr} – {openEndStr}
                        </div>
                      </div>
                      <div>
                        <span className="text-[#64748B]">当前可约起止</span>
                        <div className="mt-0.5 font-mono font-semibold text-emerald-700">
                          {detailLoading && !matchedDetail
                            ? '查询中...'
                            : bookableStartStr && bookableEndStr
                              ? `${bookableStartStr} – ${bookableEndStr}`
                              : '暂无可约区间'}
                        </div>
                      </div>
                      <div className="col-span-2 flex flex-wrap items-center justify-between gap-1 border-t border-[#EEF2F6] pt-1.5 text-[10px] text-[#64748B]">
                        <span>
                          单次最短 <strong className="font-mono text-[#0D223D]">{minDurMin}</strong> 分钟
                          {maxDurMin > 0 ? (
                            <>
                              {' '}· 最长 <strong className="font-mono text-[#0D223D]">{maxDurMin}</strong> 分钟
                            </>
                          ) : (
                            ' · 闭馆前不限单次时长'
                          )}
                        </span>
                        <span className="font-mono text-[#0D386B]">
                          {matchedDetail
                            ? matchedDetail.source === 'device_api'
                              ? '单座实时接口'
                              : matchedDetail.source === 'room_api'
                                ? '实时同步'
                                : '演练数据'
                            : detailLoading
                              ? '实时请求中'
                              : '列表预览'}
                        </span>
                      </div>
                    </div>

                    {detailError && (
                      <p className="mt-2 text-[11px] text-amber-700">
                        单座实时拉取提示：{detailError}（当前展示最近列表缓存）
                      </p>
                    )}

                    {/* 动态按该座真实 openStart-openEnd 绘制的时间条 */}
                    <div className="mt-3.5">
                      <div className="mb-1 flex justify-between font-mono text-[10px] text-[#64748B]">
                        {ticks.map((t, i) => (
                          <span key={i}>{t}</span>
                        ))}
                      </div>
                      <div
                        className={`relative h-3.5 w-full overflow-hidden rounded-full border ${
                          activeSeat.status === 'unreleased'
                            ? 'border-slate-300 bg-slate-200'
                            : activeSeat.status === 'occupied'
                              ? 'border-rose-200 bg-slate-200'
                              : 'border-emerald-300 bg-slate-200'
                        }`}
                      >
                        {/* 开放窗口底色（支持多段开放窗口，闭馆/午休间隙自然呈灰色） */}
                        {activeSeat.status !== 'unreleased' &&
                          (openWindows.length > 0
                            ? openWindows
                            : [{ start: dayStart, end: dayEnd, startStr: openStartStr, endStr: openEndStr, durationMin: daySpan }]
                          ).map((win, idx) => {
                            const style = toRangeStyle(win.start, win.end, 1);
                            if (!style) return null;
                            return (
                              <div
                                key={`open-${idx}`}
                                title={`开放时段 ${win.startStr}-${win.endStr}`}
                                style={style}
                                className="absolute top-0 bottom-0 bg-emerald-100"
                              />
                            );
                          })}

                        {/* 实际可预约空闲时段（绿色） */}
                        {activeSeat.status !== 'unreleased' &&
                          activeSeat.freeSlots.map((slot, idx) => {
                            const style = toRangeStyle(slot.start, slot.end, 1);
                            if (!style) return null;
                            return (
                              <div
                                key={`free-${idx}`}
                                title={`可约时段 ${slot.startStr}-${slot.endStr}`}
                                style={style}
                                className="absolute top-0 bottom-0 bg-emerald-400/85"
                              />
                            );
                          })}

                        {/* 今日已过时段（灰色遮罩） */}
                        {pastStyle && (
                          <div
                            title={`已过时段 ${openStartStr}-${data?.effectiveStartTime}`}
                            style={pastStyle}
                            className="absolute top-0 bottom-0 bg-slate-400/55"
                          />
                        )}

                        {/* 已被占用时段（红色） */}
                        {activeSeat.busySlots.map((slot, idx) => {
                          const style = toRangeStyle(slot.start, slot.end, 1.5);
                          if (!style) return null;
                          return (
                            <div
                              key={`busy-${idx}`}
                              title={`已占用 ${slot.startStr}-${slot.endStr}`}
                              style={style}
                              className="absolute top-0 bottom-0 bg-rose-500/90"
                            />
                          );
                        })}

                        {/* 用户当前选择的预约时段（深蓝高亮，冲突/超限呈橙黄警示） */}
                        {selStyle && (
                          <div
                            title={`当前所选预约 ${bookStart}-${bookEnd}${
                              selConflictBusy
                                ? '（与已占时段冲突）'
                                : selOverMax
                                  ? `（超过单次最长 ${maxDurMin} 分钟限制）`
                                  : selOutOfOpen
                                    ? `（超出开放时段 ${openStartStr}-${openEndStr}）`
                                    : ''
                            }`}
                            style={selStyle}
                            className={`pointer-events-none absolute top-0 bottom-0 rounded-full border border-white/80 transition-all duration-150 ${
                              selHasIssue ? 'bg-amber-500/85' : 'bg-[#0D386B]/80'
                            }`}
                          />
                        )}
                      </div>

                      {/* 图例与占用摘要 */}
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#64748B]">
                        <div className="flex flex-wrap items-center gap-2.5">
                          <span className="inline-flex items-center gap-1">
                            <span className="h-2 w-2 rounded-full bg-emerald-400" />
                            可约
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <span className="h-2 w-2 rounded-full bg-rose-500" />
                            已占
                          </span>
                          {selStyle && (
                            <span
                              className={`inline-flex items-center gap-1 font-medium ${
                                selHasIssue ? 'text-amber-700' : 'text-[#0D386B]'
                              }`}
                            >
                              <span
                                className={`h-2 w-2 rounded-full ${
                                  selHasIssue ? 'bg-amber-500' : 'bg-[#0D386B]'
                                }`}
                              />
                              {selConflictBusy
                                ? '与已占时段冲突'
                                : selOverMax
                                  ? `超单次上限(${maxDurMin}分)`
                                  : selOutOfOpen
                                    ? '超出开放时间'
                                    : `已选 ${bookStart}-${bookEnd}`}
                            </span>
                          )}
                          {pastStyle && (
                            <span className="inline-flex items-center gap-1">
                              <span className="h-2 w-2 rounded-full bg-slate-400/70" />
                              已过
                            </span>
                          )}
                        </div>
                      </div>

                      {activeSeat.busySlots.length > 0 && (
                        <p className="mt-1.5 font-mono text-[11px] text-rose-600">
                          已占时段：
                          {activeSeat.busySlots
                            .map((s) => `${s.startStr}-${s.endStr}`)
                            .join('、')}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Free Slots */}
                  <div>
                    <p className="text-xs font-medium text-[#4D627A]">
                      该座实时可预约空闲段（点击填入）
                    </p>
                    {activeSeat.status === 'unreleased' ? (
                      <p className="mt-1.5 text-xs text-[#0D386B]">
                        {matchedDetail?.reason ||
                          data?.batchStatus?.message ||
                          '该日期尚未开放预约，可点击下方按钮提前设为 18:01 自动抢座心仪座位。'}
                      </p>
                    ) : activeSeat.freeSlots.length === 0 ? (
                      <p className="mt-1.5 text-xs text-red-600">
                        该座位今日/当日暂无剩余可约空档，可开启上方「服务器端轮询找座」持续盯座。
                      </p>
                    ) : (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {activeSeat.freeSlots.map((slot, idx) => {
                          const clampedEnd =
                            maxDurMin > 0 && slot.end - slot.start > maxDurMin
                              ? formatMinToTime(slot.start + maxDurMin)
                              : slot.endStr;
                          const isCurrent = bookStart === slot.startStr && bookEnd === clampedEnd;
                          return (
                            <button
                              key={idx}
                              type="button"
                              onClick={() => {
                                setBookStart(slot.startStr);
                                setBookEnd(clampedEnd);
                              }}
                              className={`rounded-lg border px-2.5 py-1.5 font-mono text-xs font-medium transition-colors ${
                                isCurrent
                                  ? 'border-[#0D386B] bg-[#0D386B] text-white'
                                  : 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:border-emerald-400'
                              }`}
                            >
                              {slot.startStr} – {slot.endStr}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Booking Time Inputs (移动端防错位：等高单行标签 + min-w-0 + 统一 h-10 + 防 iOS 自动缩放) */}
                  <div>
                    <div className="grid grid-cols-2 items-end gap-2.5">
                      <div className="flex min-w-0 flex-col">
                        <label className="mb-1 flex items-center justify-between gap-1 text-xs font-medium text-[#4D627A]">
                          <span className="shrink-0">预约开始</span>
                          <span className="truncate font-mono text-[10px] text-[#64748B]">
                            ≥{bookableStartStr || openStartStr}
                          </span>
                        </label>
                        <input
                          type="time"
                          min={bookableStartStr || openStartStr}
                          max={openEndStr}
                          value={bookStart}
                          onChange={(e) => setBookStart(e.target.value)}
                          className="h-10 w-full min-w-0 max-w-full rounded-lg border border-[#CBD5E1] bg-white px-2.5 py-2 font-mono text-base text-[#0D223D] outline-none focus:border-[#0D386B] sm:px-3 sm:text-sm"
                        />
                      </div>
                      <div className="flex min-w-0 flex-col">
                        <label className="mb-1 flex items-center justify-between gap-1 text-xs font-medium text-[#4D627A]">
                          <span className="shrink-0">预约结束</span>
                          <span className="truncate font-mono text-[10px] text-[#64748B]">
                            ≤{suggestedMaxEndStr || bookableEndStr || openEndStr}
                          </span>
                        </label>
                        <input
                          type="time"
                          min={bookStart}
                          max={suggestedMaxEndStr || openEndStr}
                          value={bookEnd}
                          onChange={(e) => setBookEnd(e.target.value)}
                          className="h-10 w-full min-w-0 max-w-full rounded-lg border border-[#CBD5E1] bg-white px-2.5 py-2 font-mono text-base text-[#0D223D] outline-none focus:border-[#0D386B] sm:px-3 sm:text-sm"
                        />
                      </div>
                    </div>

                    {suggestedMaxEndStr && selEndMin > (suggestedMaxEndMin ?? 0) && (
                      <div className="mt-2 flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">
                        <span>
                          从 {bookStart} 起该座位最晚可约至 <strong className="font-mono">{suggestedMaxEndStr}</strong>
                        </span>
                        <button
                          type="button"
                          onClick={() => setBookEnd(suggestedMaxEndStr)}
                          className="rounded bg-[#DF7900] px-2 py-0.5 font-semibold text-white hover:bg-[#C66B00]"
                        >
                          自动校准
                        </button>
                      </div>
                    )}
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
                      activeSeat.status === 'occupied' ||
                      activeSeat.status === 'unreleased'
                    }
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#0D386B] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#0A2C55] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Sparkles className="h-4 w-4" />
                    {activeSeat.status === 'unreleased'
                      ? '该批次尚未放座（请使用下方 18:01 自动抢座）'
                      : booking
                        ? '正在提交预约...'
                        : `确认预约 ${activeSeat.devName}`}
                  </button>

                  <button
                    type="button"
                    onClick={() => toggleSeatBlacklist(activeSeat.seatNumber)}
                    disabled={Boolean(activeServerTask)}
                    className={`flex w-full items-center justify-center gap-2 rounded-lg border px-4 py-2 text-xs font-semibold transition-colors disabled:opacity-50 ${
                      pollExcludedSeats.includes(activeSeat.seatNumber)
                        ? 'border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100'
                        : 'border-[#DCE4EE] bg-white text-[#4D627A] hover:border-rose-300 hover:text-rose-700'
                    }`}
                  >
                    <Ban className="h-3.5 w-3.5" />
                    {pollExcludedSeats.includes(activeSeat.seatNumber)
                      ? `已在轮询黑名单中（点击移出 ${activeSeat.devName}）`
                      : `将 ${activeSeat.devName} 加入轮询找座黑名单`}
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      onJumpToScheduler({
                        areaId: activeSeat.areaId,
                        seatNumber: activeSeat.seatNumber,
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
              );
            })()
          )}
        </div>
      </div>
    </div>
  );
};
