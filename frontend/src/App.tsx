import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CalendarClock,
  CreditCard,
  Home,
  KeyRound,
  LogIn,
  LogOut,
  MapPin,
  ShieldCheck,
  X,
} from 'lucide-react';
import { api } from './api';
import type { AuthConfigResponse, LibraryArea, OverviewStats, UserProfile } from './types';
import { DluflEmblem } from './components/DluflEmblem';
import { IcspBindModal, LoginModal } from './components/AuthModals';
import { HomeDashboard } from './components/HomeDashboard';
import { SeatSelector } from './components/SeatSelector';
import { SchedulerPanel } from './components/SchedulerPanel';
import { CardQueryPanel } from './components/CardQueryPanel';

type NavTab = 'home' | 'seats' | 'scheduler' | 'cards';

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('home');
  const [selectedAreaId, setSelectedAreaId] = useState<string | undefined>(undefined);
  const [schedulerPreset, setSchedulerPreset] = useState<{
    areaId: string;
    seatNumber: number;
    startTime: string;
    endTime: string;
  } | null>(null);

  const [user, setUser] = useState<UserProfile | null>(null);
  const [authConfig, setAuthConfig] = useState<AuthConfigResponse | null>(null);
  const [areas, setAreas] = useState<LibraryArea[]>([]);
  const [overview, setOverview] = useState<OverviewStats | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const [loginOpen, setLoginOpen] = useState(false);
  const [intranetInitial, setIntranetInitial] = useState(false);
  const [bindOpen, setBindOpen] = useState(false);

  const visitRecordedRef = useRef(false);

  const refreshAuth = useCallback(async () => {
    const [meRes, cfgRes] = await Promise.all([api.auth.me(), api.auth.config()]);
    setUser(meRes.user);
    setAuthConfig(cfgRes);
  }, []);

  const refreshOverview = useCallback(async () => {
    const [ov, areaRes] = await Promise.all([api.stats.overview(), api.library.areas()]);
    setOverview(ov);
    setAreas(areaRes.areas);
  }, []);

  useEffect(() => {
    // 处理 CAS 回调带回来的错误提示或内网登录参数，并清理 URL Query
    const params = new URLSearchParams(window.location.search);
    const errParam = params.get('authError');
    const intranetParam = params.get('intranetLogin');
    if (errParam) {
      setAuthError(errParam);
      params.delete('authError');
    }
    if (intranetParam === '1') {
      setIntranetInitial(true);
      setLoginOpen(true);
      params.delete('intranetLogin');
    }
    if (errParam || intranetParam) {
      const clean = params.toString();
      const nextUrl = window.location.pathname + (clean ? `?${clean}` : '');
      window.history.replaceState({}, '', nextUrl);
    }

    void refreshAuth();

    // 记录一次首页访问（使用 ref 防止 React StrictMode 开发模式下重复记两次）
    if (!visitRecordedRef.current) {
      visitRecordedRef.current = true;
      api.stats
        .recordVisit(window.location.pathname)
        .catch(() => {})
        .finally(() => {
          void refreshOverview();
        });
    } else {
      void refreshOverview();
    }
  }, [refreshAuth, refreshOverview]);

  const handleLogout = async () => {
    try {
      const res = await api.auth.logout(true);
      setUser(null);
      if (res.casLogoutUrl) {
        window.location.href = res.casLogoutUrl;
      } else {
        await refreshOverview();
      }
    } catch {
      setUser(null);
    }
  };

  const handleNavigate = (tab: NavTab, areaId?: string) => {
    if (areaId) setSelectedAreaId(areaId);
    setActiveTab(tab);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const navItems: Array<{ id: NavTab; label: string; icon: React.ReactNode }> = [
    { id: 'home', label: '总览首页', icon: <Home className="h-4 w-4" /> },
    { id: 'seats', label: '区域选座', icon: <MapPin className="h-4 w-4" /> },
    { id: 'scheduler', label: '18:01 定期抢座', icon: <CalendarClock className="h-4 w-4" /> },
    { id: 'cards', label: '预约卡片查询', icon: <CreditCard className="h-4 w-4" /> },
  ];

  return (
    <div className="flex min-h-screen flex-col bg-[#F3F6FA] text-[#0D223D]">
      {/* Top Institutional Bar */}
      <header className="sticky top-0 z-40 border-b border-[#DCE4EE] bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <button
            type="button"
            onClick={() => handleNavigate('home')}
            className="flex items-center gap-2.5 text-left"
          >
            <DluflEmblem className="h-9 w-9 shrink-0" />
            <div>
              <div className="text-sm font-bold leading-tight text-[#0D386B] sm:text-base">
                大外图书馆座位预约系统
              </div>
              <div className="text-[11px] text-[#64748B]">DLUFL Library · ICSpace & CAS</div>
            </div>
          </button>

          {/* Desktop Navigation */}
          <nav className="hidden items-center gap-1 md:flex" aria-label="主导航">
            {navItems.map((item) => {
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleNavigate(item.id)}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
                    active
                      ? 'bg-[#0D386B] text-white'
                      : 'text-[#4D627A] hover:bg-[#F3F6FA] hover:text-[#0D223D]'
                  }`}
                >
                  {item.icon}
                  {item.label}
                </button>
              );
            })}
          </nav>

          {/* Auth Controls */}
          <div className="flex items-center gap-2">
            {user ? (
              <>
                <button
                  type="button"
                  onClick={() => setBindOpen(true)}
                  className={`hidden items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium sm:inline-flex ${
                    user.icspaceBound
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                      : 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100'
                  }`}
                >
                  {user.icspaceBound ? (
                    <>
                      <ShieldCheck className="h-3.5 w-3.5" />
                      ICSpace 已授权
                    </>
                  ) : (
                    <>
                      <KeyRound className="h-3.5 w-3.5" />
                      授权抢座凭证
                    </>
                  )}
                </button>

                <div className="flex items-center gap-2 rounded-lg border border-[#DCE4EE] bg-[#F8FAFC] px-3 py-1.5">
                  <div className="text-right">
                    <div className="text-xs font-semibold text-[#0D223D]">{user.name}</div>
                    <div className="font-mono text-[10px] text-[#64748B]">
                      {user.studentId} · 第{user.loginCount}次登录
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleLogout}
                    title="退出登录（同步注销 CAS）"
                    className="rounded-md p-1.5 text-[#4D627A] hover:bg-red-50 hover:text-red-600"
                  >
                    <LogOut className="h-4 w-4" />
                  </button>
                </div>
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setIntranetInitial(false);
                  setLoginOpen(true);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#0D386B] px-4 py-2 text-sm font-semibold text-white hover:bg-[#0A2C55]"
              >
                <LogIn className="h-4 w-4" />
                CAS 登录
              </button>
            )}
          </div>
        </div>

        {/* Mobile Nav Bar */}
        <div className="flex overflow-x-auto border-t border-[#EEF2F6] bg-white px-3 py-1.5 md:hidden">
          {navItems.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavigate(item.id)}
                className={`inline-flex shrink-0 items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium ${
                  active ? 'bg-[#0D386B] text-white' : 'text-[#4D627A]'
                }`}
              >
                {item.icon}
                {item.label}
              </button>
            );
          })}
        </div>
      </header>

      {/* Main Container */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
        {authError && (
          <div className="mb-5 flex items-center justify-between rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>CAS 身份验证提示：{authError}</span>
            </div>
            <button
              type="button"
              onClick={() => setAuthError(null)}
              className="rounded p-1 hover:bg-red-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {activeTab === 'home' && (
          <HomeDashboard
            overview={overview}
            areas={areas}
            user={user}
            onNavigate={handleNavigate}
            onOpenLogin={() => setLoginOpen(true)}
            onOpenBind={() => setBindOpen(true)}
          />
        )}

        {activeTab === 'seats' && (
          <SeatSelector
            areas={areas}
            initialAreaId={selectedAreaId}
            user={user}
            onOpenLogin={() => setLoginOpen(true)}
            onOpenBind={() => setBindOpen(true)}
            onBookedSuccess={refreshOverview}
            onJumpToScheduler={(preset) => {
              setSchedulerPreset(preset);
              setActiveTab('scheduler');
            }}
          />
        )}

        {activeTab === 'scheduler' && (
          <SchedulerPanel
            areas={areas}
            user={user}
            preset={schedulerPreset}
            onOpenLogin={() => setLoginOpen(true)}
            onOpenBind={() => setBindOpen(true)}
            onStatsRefresh={refreshOverview}
          />
        )}

        {activeTab === 'cards' && <CardQueryPanel user={user} />}
      </main>

      <footer className="mt-auto w-full border-t border-[#DCE4EE] bg-white py-3.5 text-xs text-[#64748B]">
        <div className="flex w-full items-center justify-end px-4 sm:px-6">
          <span className="font-mono">
            累计成功约座 {overview?.totalSuccessfulBookings ?? 0} 次 · 系统累计访问{' '}
            {overview?.totalVisits ?? 0} 次
          </span>
        </div>
      </footer>

      <LoginModal
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        authConfig={authConfig}
        initialIntranetMode={intranetInitial}
        onSuccess={async () => {
          await Promise.all([refreshAuth(), refreshOverview()]);
        }}
      />

      <IcspBindModal
        open={bindOpen}
        onClose={() => setBindOpen(false)}
        user={user}
        onUpdated={async () => {
          await Promise.all([refreshAuth(), refreshOverview()]);
        }}
      />
    </div>
  );
}
