import React, { useCallback, useEffect, useState } from 'react';
import {
  BellRing,
  CheckCircle2,
  Clock,
  Pause,
  Play,
  Plus,
  Radio,
  Square,
  Terminal,
  Trash2,
} from 'lucide-react';
import { api } from '../api';
import type { LibraryArea, ScheduledTask, UserProfile } from '../types';

interface SchedulerPanelProps {
  areas: LibraryArea[];
  user: UserProfile | null;
  preset?: { areaId: string; seatNumber: number; startTime: string; endTime: string } | null;
  onOpenLogin: () => void;
  onOpenBind: () => void;
  onStatsRefresh: () => Promise<void>;
}

const WEEKDAY_LABELS = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 0, label: '周日' },
];

export const SchedulerPanel: React.FC<SchedulerPanelProps> = ({
  areas,
  user,
  preset,
  onOpenLogin,
  onOpenBind,
  onStatsRefresh,
}) => {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expandedLogTaskId, setExpandedLogTaskId] = useState<number | null>(null);

  // Create form state (defaults tuned to 18:00 release -> 18:01 auto-grab + continuous polling!)
  const [name, setName] = useState('每日 18:01 自动抢次日座');
  const [selectedAreas, setSelectedAreas] = useState<string[]>(['100475787', '100475785']);
  const [preferredSeatsText, setPreferredSeatsText] = useState('');
  const [seatMin, setSeatMin] = useState(1);
  const [seatMax, setSeatMax] = useState(120);
  const [startTime, setStartTime] = useState('08:30');
  const [endTime, setEndTime] = useState('22:00');
  const [triggerTime, setTriggerTime] = useState('18:01');
  const [targetDayOffset, setTargetDayOffset] = useState<0 | 1>(1);
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5, 6, 0]);
  const [isRecurring, setIsRecurring] = useState(true);
  const [minFreeRate, setMinFreeRate] = useState(80);
  const [forceFullRange, setForceFullRange] = useState(false);
  const [pollIntervalSec, setPollIntervalSec] = useState(10);
  const [maxPollMinutes, setMaxPollMinutes] = useState(0); // 0 = 持续轮询直到约上

  useEffect(() => {
    if (preset) {
      setSelectedAreas([preset.areaId]);
      setPreferredSeatsText(String(preset.seatNumber));
      setStartTime(preset.startTime);
      setEndTime(preset.endTime);
      const areaName = areas.find((a) => a.id === preset.areaId)?.name || '';
      setName(`18:01 抢 ${areaName} ${preset.seatNumber}号座`);
    }
  }, [preset, areas]);

  const loadTasks = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const res = await api.library.schedules();
      setTasks(res.tasks);
    } catch (err: any) {
      setError(err?.message || '获取定时任务失败');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  // 有任务处于轮询状态时自动每 4 秒刷新进度
  useEffect(() => {
    if (!user) return;
    const hasPolling = tasks.some((t) => t.status === 'polling');
    if (!hasPolling) return;
    const id = window.setInterval(() => {
      void loadTasks();
      void onStatsRefresh();
    }, 4000);
    return () => window.clearInterval(id);
  }, [tasks, user, loadTasks, onStatsRefresh]);

  const toggleArea = (id: string) => {
    setSelectedAreas((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  };

  const toggleWeekday = (day: number) => {
    setWeekdays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day],
    );
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) {
      onOpenLogin();
      return;
    }
    if (!user.icspaceBound) {
      onOpenBind();
      return;
    }
    if (selectedAreas.length === 0) {
      setError('请至少选择一个目标区域');
      return;
    }

    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const preferredSeats = preferredSeatsText
        .split(/[,，\s]+/)
        .map((s) => parseInt(s, 10))
        .filter((n) => !Number.isNaN(n) && n > 0);

      await api.library.createSchedule({
        name,
        areaIds: selectedAreas,
        preferredSeats,
        seatMin,
        seatMax,
        startTime,
        endTime,
        minFreeRate,
        forceFullRange,
        triggerTime,
        targetDayOffset,
        weekdays,
        isRecurring,
        pollIntervalSec,
        maxPollMinutes,
        enabled: true,
      });

      setNotice(`已创建定时任务「${name}」，将在 ${triggerTime} 准时开抢，无座自动持续轮询！`);
      await Promise.all([loadTasks(), onStatsRefresh()]);
    } catch (err: any) {
      setError(err?.message || '创建定时任务失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleTriggerNow = async (task: ScheduledTask) => {
    setError(null);
    setNotice(null);
    try {
      const res = await api.library.triggerSchedule(task.id);
      setExpandedLogTaskId(task.id);
      setNotice(
        res.task.status === 'succeeded'
          ? `抢座成功：${res.task.lastMessage}`
          : `已立即启动寻座与轮询：${res.task.lastMessage || '正在持续扫描空位'}`,
      );
      await Promise.all([loadTasks(), onStatsRefresh()]);
    } catch (err: any) {
      setError(err?.message || '手动触发失败');
    }
  };

  const handleStopPolling = async (taskId: number) => {
    try {
      await api.library.stopSchedule(taskId);
      await Promise.all([loadTasks(), onStatsRefresh()]);
    } catch (err: any) {
      setError(err?.message || '停止轮询失败');
    }
  };

  const handleToggleEnabled = async (task: ScheduledTask) => {
    try {
      await api.library.updateSchedule(task.id, { enabled: !task.enabled });
      await Promise.all([loadTasks(), onStatsRefresh()]);
    } catch (err: any) {
      setError(err?.message || '更新状态失败');
    }
  };

  const handleDelete = async (taskId: number) => {
    try {
      await api.library.deleteSchedule(taskId);
      await Promise.all([loadTasks(), onStatsRefresh()]);
    } catch (err: any) {
      setError(err?.message || '删除任务失败');
    }
  };

  if (!user) {
    return (
      <div className="rounded-2xl border border-[#DCE4EE] bg-white p-10 text-center">
        <Clock className="mx-auto h-10 w-10 text-[#0D386B]" />
        <h2 className="mt-4 text-lg font-semibold text-[#0D223D]">登录后配置 18:01 定期预约与轮询找座</h2>
        <p className="mx-auto mt-2 max-w-lg text-sm text-[#4D627A]">
          大外图书馆每天 18:00 放出第二天座位。完成 CAS 统一身份认证后，您可以设置每天 18:01 自动开抢；如果第一时间没有抢到空座，服务端将自动持续轮询找座直到成功约上。
        </p>
        <button
          type="button"
          onClick={onOpenLogin}
          className="mt-5 rounded-lg bg-[#0D386B] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#0A2C55]"
        >
          使用数字大外 CAS 登录
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Workflow Banner */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[#DCE4EE] bg-white px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-lg bg-[#FFF7ED] p-2 text-[#DF7900]">
            <BellRing className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-[#0D223D]">
              18:00 放座 · 18:01 准点开抢 · 无座自动轮询找座引擎
            </h2>
            <p className="mt-0.5 text-xs text-[#4D627A]">
              到达设定开抢时间（默认 18:01）后，系统自动按区域优先级与心仪座号尝试抢次日座位；若目标时段已满，自动保持后台轮询扫描，一旦有人退座或释放空位立即锁定。
            </p>
          </div>
        </div>
        {!user.icspaceBound && (
          <button
            type="button"
            onClick={onOpenBind}
            className="rounded-lg bg-[#DF7900] px-4 py-2 text-xs font-semibold text-white hover:bg-[#C66B00]"
          >
            尚未授权 ICSpace · 立即绑定
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {notice}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Create Rule Form */}
        <form
          onSubmit={handleCreate}
          className="space-y-4 rounded-xl border border-[#DCE4EE] bg-white p-5 lg:col-span-5"
        >
          <div className="flex items-center justify-between border-b border-[#EEF2F6] pb-3">
            <h3 className="text-sm font-semibold text-[#0D223D]">新建定期预约 / 轮询抢座任务</h3>
            <span className="rounded bg-[#E7EEF7] px-2 py-0.5 font-mono text-xs font-medium text-[#0D386B]">
              默认 18:01
            </span>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-[#4D627A]">任务名称</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-[#CBD5E1] px-3 py-2 text-sm outline-none focus:border-[#0D386B]"
              required
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-[#4D627A]">
              目标区域（可多选，按勾选先后作为备选优先级）
            </label>
            <div className="grid grid-cols-2 gap-2">
              {areas.map((area) => {
                const idx = selectedAreas.indexOf(area.id);
                const checked = idx !== -1;
                return (
                  <button
                    key={area.id}
                    type="button"
                    onClick={() => toggleArea(area.id)}
                    className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left text-xs font-medium transition-colors ${
                      checked
                        ? 'border-[#0D386B] bg-[#0D386B] text-white'
                        : 'border-[#DCE4EE] bg-[#F8FAFC] text-[#0D223D] hover:border-[#0D386B]/50'
                    }`}
                  >
                    <span>{area.name}</span>
                    {checked && (
                      <span className="rounded bg-white/20 px-1.5 py-0.5 font-mono text-[10px]">
                        P{idx + 1}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-[#4D627A]">开抢时间（每天）</label>
              <input
                type="time"
                value={triggerTime}
                onChange={(e) => setTriggerTime(e.target.value)}
                className="w-full rounded-lg border border-[#CBD5E1] px-3 py-2 font-mono text-sm"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[#4D627A]">预约目标日期</label>
              <select
                value={targetDayOffset}
                onChange={(e) => setTargetDayOffset(Number(e.target.value) as 0 | 1)}
                className="w-full rounded-lg border border-[#CBD5E1] bg-white px-3 py-2 text-sm"
              >
                <option value={1}>次日座位（18:00 放次日）</option>
                <option value={0}>当日剩余空座</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-[#4D627A]">座位开始时段</label>
              <input
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="w-full rounded-lg border border-[#CBD5E1] px-3 py-2 font-mono text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[#4D627A]">座位结束时段</label>
              <input
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="w-full rounded-lg border border-[#CBD5E1] px-3 py-2 font-mono text-sm"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-[#4D627A]">
              心仪座位号（选填，多个用逗号隔开，如 12, 18, 25）
            </label>
            <input
              type="text"
              value={preferredSeatsText}
              onChange={(e) => setPreferredSeatsText(e.target.value)}
              placeholder="留空则在座位号范围内自动择优"
              className="w-full rounded-lg border border-[#CBD5E1] px-3 py-2 font-mono text-sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-[#4D627A]">兜底最小座号</label>
              <input
                type="number"
                min={1}
                max={500}
                value={seatMin}
                onChange={(e) => setSeatMin(Number(e.target.value))}
                className="w-full rounded-lg border border-[#CBD5E1] px-3 py-2 font-mono text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[#4D627A]">兜底最大座号</label>
              <input
                type="number"
                min={1}
                max={500}
                value={seatMax}
                onChange={(e) => setSeatMax(Number(e.target.value))}
                className="w-full rounded-lg border border-[#CBD5E1] px-3 py-2 font-mono text-sm"
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-[#4D627A]">执行星期</label>
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAY_LABELS.map((w) => {
                const active = weekdays.includes(w.value);
                return (
                  <button
                    key={w.value}
                    type="button"
                    onClick={() => toggleWeekday(w.value)}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                      active
                        ? 'bg-[#0D386B] text-white'
                        : 'border border-[#DCE4EE] bg-[#F8FAFC] text-[#4D627A]'
                    }`}
                  >
                    {w.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 rounded-lg border border-[#DCE4EE] bg-[#F8FAFC] p-3">
            <div>
              <label className="mb-1 flex items-center justify-between text-xs font-medium text-[#4D627A]">
                <span>无座轮询间隔</span>
                <span className="font-mono font-semibold text-[#0D386B]">{pollIntervalSec} 秒</span>
              </label>
              <input
                type="range"
                min={5}
                max={60}
                step={5}
                value={pollIntervalSec}
                onChange={(e) => setPollIntervalSec(Number(e.target.value))}
                className="mt-1.5 w-full accent-[#0D386B]"
              />
              <div className="mt-0.5 flex justify-between font-mono text-[10px] text-[#64748B]">
                <span>5s (高频)</span>
                <span>30s</span>
                <span>60s (温和)</span>
              </div>
            </div>
            <div>
              <label className="mb-1 flex items-center justify-between text-xs font-medium text-[#4D627A]">
                <span>轮询上限</span>
                <span className="font-mono font-semibold text-[#0D386B]">
                  {maxPollMinutes === 0 ? '直到约上' : `${maxPollMinutes} 分钟`}
                </span>
              </label>
              <input
                type="range"
                min={0}
                max={360}
                step={30}
                value={maxPollMinutes}
                onChange={(e) => setMaxPollMinutes(Number(e.target.value))}
                className="mt-1.5 w-full accent-[#0D386B]"
              />
              <div className="mt-0.5 flex justify-between font-mono text-[10px] text-[#64748B]">
                <span>不限</span>
                <span>3h</span>
                <span>6h</span>
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[#4D627A]">
                最低空闲率（{minFreeRate}%）
              </label>
              <input
                type="range"
                min={20}
                max={100}
                step={5}
                value={minFreeRate}
                onChange={(e) => setMinFreeRate(Number(e.target.value))}
                className="w-full accent-[#0D386B]"
              />
            </div>
            <div className="flex flex-col justify-center gap-1.5 text-xs text-[#0D223D]">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={isRecurring}
                  onChange={(e) => setIsRecurring(e.target.checked)}
                  className="accent-[#0D386B]"
                />
                周期自动重复执行
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={forceFullRange}
                  onChange={(e) => setForceFullRange(e.target.checked)}
                  className="accent-[#0D386B]"
                />
                仅约全时段完全空闲
              </label>
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#0D386B] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#0A2C55] disabled:opacity-60"
          >
            <Plus className="h-4 w-4" />
            {submitting ? '正在创建...' : '保存并启用定期预约'}
          </button>
        </form>

        {/* Active Tasks List */}
        <div className="space-y-4 lg:col-span-7">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[#0D223D]">
              我的定期预约与轮询任务（{tasks.length}）
            </h3>
            <span className="text-xs text-[#64748B]">轮询任务每 4 秒自动同步最新日志</span>
          </div>

          {loading && tasks.length === 0 ? (
            <div className="rounded-xl border border-[#DCE4EE] bg-white p-8 text-center text-sm text-[#64748B]">
              正在加载任务列表...
            </div>
          ) : tasks.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[#CBD5E1] bg-white p-10 text-center text-sm text-[#4D627A]">
              您还没有创建定期预约任务。在左侧配置一个每天 18:01 自动开抢规则吧！
            </div>
          ) : (
            tasks.map((task) => {
              const isPolling = task.status === 'polling';
              const isSucceeded = task.status === 'succeeded';
              const showLogs = expandedLogTaskId === task.id;

              return (
                <div
                  key={task.id}
                  className={`rounded-xl border bg-white p-5 ${
                    isPolling ? 'border-[#DF7900]' : 'border-[#DCE4EE]'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-base font-semibold text-[#0D223D]">{task.name}</h4>
                        {isPolling ? (
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-[#B45309]">
                            <Radio className="polling-dot h-3.5 w-3.5 text-[#DF7900]" />
                            轮询找座中（已尝试 {task.pollAttempts} 次）
                          </span>
                        ) : isSucceeded ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            本轮已成功约上
                          </span>
                        ) : !task.enabled ? (
                          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-500">
                            已暂停
                          </span>
                        ) : (
                          <span className="rounded-full bg-[#E7EEF7] px-2.5 py-0.5 text-xs font-medium text-[#0D386B]">
                            等待 {task.triggerTime} 开抢
                          </span>
                        )}
                      </div>

                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#4D627A]">
                        <span>
                          区域优先级：
                          <strong className="text-[#0D223D]">
                            {task.areas.map((a) => a.name).join(' › ')}
                          </strong>
                        </span>
                        <span className="font-mono">
                          时段 {task.startTime}–{task.endTime}
                        </span>
                        <span className="font-mono">
                          轮询每 {task.pollIntervalSec}s（
                          {task.maxPollMinutes === 0 ? '持续直到约上' : `上限 ${task.maxPollMinutes}m`}
                          ）
                        </span>
                      </div>

                      {task.preferredSeats.length > 0 && (
                        <p className="mt-1 text-xs text-[#4D627A]">
                          心仪座位号：
                          <span className="font-mono font-semibold text-[#0D386B]">
                            {task.preferredSeats.join(', ')}
                          </span>{' '}
                          （无座回退 {task.seatMin}–{task.seatMax} 号）
                        </p>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      {isPolling ? (
                        <button
                          type="button"
                          onClick={() => handleStopPolling(task.id)}
                          className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100"
                        >
                          <Square className="h-3.5 w-3.5" />
                          停止轮询
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleTriggerNow(task)}
                          className="inline-flex items-center gap-1 rounded-lg bg-[#0D386B] px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-[#0A2C55]"
                        >
                          <Play className="h-3.5 w-3.5" />
                          立即开抢
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => handleToggleEnabled(task)}
                        className="inline-flex items-center gap-1 rounded-lg border border-[#DCE4EE] px-2.5 py-1.5 text-xs font-medium text-[#0D223D] hover:bg-[#F3F6FA]"
                      >
                        {task.enabled ? (
                          <>
                            <Pause className="h-3.5 w-3.5" />
                            暂停
                          </>
                        ) : (
                          <>
                            <Play className="h-3.5 w-3.5" />
                            启用
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => setExpandedLogTaskId(showLogs ? null : task.id)}
                        className="inline-flex items-center gap-1 rounded-lg border border-[#DCE4EE] px-2.5 py-1.5 text-xs font-medium text-[#4D627A] hover:bg-[#F3F6FA]"
                      >
                        <Terminal className="h-3.5 w-3.5" />
                        日志
                      </button>

                      <button
                        type="button"
                        onClick={() => handleDelete(task.id)}
                        className="rounded-lg border border-red-200 p-1.5 text-red-600 hover:bg-red-50"
                        aria-label="删除任务"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {task.lastMessage && (
                    <div className="mt-3 rounded-lg bg-[#F8FAFC] px-3 py-2 text-xs text-[#4D627A]">
                      最新状态：{task.lastMessage}
                    </div>
                  )}

                  {showLogs && (
                    <div className="mt-3 rounded-lg bg-[#0D223D] p-3 font-mono text-xs text-slate-200">
                      <div className="mb-2 flex items-center justify-between text-[11px] text-slate-400">
                        <span>执行与轮询日志（最近 15 条）</span>
                        <span>目标日期：{task.activeTargetDate || '待触发'}</span>
                      </div>
                      <div className="max-h-48 space-y-1 overflow-y-auto">
                        {(task.recentLogs || []).length === 0 ? (
                          <p className="text-slate-400">暂无日志</p>
                        ) : (
                          task.recentLogs.map((log) => (
                            <div key={log.id} className="flex gap-2">
                              <span className="shrink-0 text-slate-400">
                                {new Date(log.created_at).toLocaleTimeString('zh-CN', {
                                  hour12: false,
                                })}
                              </span>
                              <span
                                className={
                                  log.level === 'success'
                                    ? 'text-emerald-300'
                                    : log.level === 'warn'
                                      ? 'text-amber-300'
                                      : log.level === 'error'
                                        ? 'text-red-300'
                                        : 'text-slate-200'
                                }
                              >
                                {log.message}
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
