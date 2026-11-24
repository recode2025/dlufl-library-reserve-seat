import React, { useState } from 'react';
import { ExternalLink, KeyRound, Lock, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { api } from '../api';
import type { AuthConfigResponse, UserProfile } from '../types';

interface LoginModalProps {
  open: boolean;
  onClose: () => void;
  authConfig: AuthConfigResponse | null;
  onSuccess: () => Promise<void>;
  initialIntranetMode?: boolean;
}

export const LoginModal: React.FC<LoginModalProps> = ({
  open,
  onClose,
  authConfig,
  onSuccess,
  initialIntranetMode = false,
}) => {
  const [tab, setTab] = useState<'cas' | 'intranet'>(initialIntranetMode ? 'intranet' : 'cas');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [demoStudentId, setDemoStudentId] = useState('2023041101');
  const [demoName, setDemoName] = useState('林晓辰');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleCasRedirect = (renew = false) => {
    const next = window.location.pathname + window.location.search;
    const params = new URLSearchParams({ next: next.startsWith('/') ? next : '/' });
    if (renew) params.set('renew', 'true');
    window.location.href = `/api/auth/cas/login?${params.toString()}`;
  };

  const handleIntranetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!username.trim() || !password) {
      setError('请输入学号/工号与密码');
      return;
    }

    setLoading(true);
    try {
      const tokenRes = await api.auth.getIntranetToken();
      const submitRes = await api.auth.submitIntranetLogin({
        token: tokenRes.token,
        username: username.trim(),
        password,
        execution: tokenRes.execution,
      });
      // 走标准服务端 /api/auth/cas/callback?ticket=... 完成票据验证与 Cookie 签发
      window.location.href = submitRes.redirectUrl;
    } catch (err: any) {
      setError(err?.message || '内网 CAS 登录失败');
      setLoading(false);
    }
  };

  const handleDemoLogin = async () => {
    setError(null);
    setLoading(true);
    try {
      await api.auth.demoLogin({
        studentId: demoStudentId,
        name: demoName,
        unitName: '软件学院',
      });
      await onSuccess();
      onClose();
    } catch (err: any) {
      setError(err?.message || '演练登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0D223D]/55 p-4 backdrop-blur-[2px]">
      <div className="w-full max-w-md rounded-xl border border-[#DCE4EE] bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-[#DCE4EE] px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-[#0D223D]">数字大外 CAS 统一身份认证</h2>
            <p className="mt-0.5 text-xs text-[#4D627A]">
              基于 cas.dlufl.edu.cn 标准票据回调验证
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-[#4D627A] hover:bg-[#F3F6FA] hover:text-[#0D223D]"
            aria-label="关闭登录窗口"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="border-b border-[#DCE4EE] bg-[#F8FAFC] px-6 pt-3">
          <div className="flex gap-4 text-sm">
            <button
              type="button"
              onClick={() => {
                setTab('cas');
                setError(null);
              }}
              className={`border-b-2 pb-2.5 font-medium transition-colors ${
                tab === 'cas'
                  ? 'border-[#0D386B] text-[#0D386B]'
                  : 'border-transparent text-[#4D627A] hover:text-[#0D223D]'
              }`}
            >
              跳转 CAS 官方登录
            </button>
            <button
              type="button"
              onClick={() => {
                setTab('intranet');
                setError(null);
              }}
              className={`border-b-2 pb-2.5 font-medium transition-colors ${
                tab === 'intranet'
                  ? 'border-[#0D386B] text-[#0D386B]'
                  : 'border-transparent text-[#4D627A] hover:text-[#0D223D]'
              }`}
            >
              内网服务端直连
            </button>
          </div>
        </div>

        <div className="p-6">
          {error && (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
              {error}
            </div>
          )}

          {tab === 'cas' ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-[#DCE4EE] bg-[#F8FAFC] p-4 text-sm text-[#4D627A]">
                <p className="font-medium text-[#0D223D]">标准重定向验证流程</p>
                <p className="mt-1 leading-relaxed">
                  点击下方按钮将直接跳转至{' '}
                  <span className="font-mono text-xs text-[#0D386B]">
                    {authConfig?.casServerUrl || 'https://cas.dlufl.edu.cn'}
                  </span>{' '}
                  完成身份认证，回调后服务端单次核验 ST 票据并签发会话，支持重复登录与安全切号。
                </p>
              </div>

              <button
                type="button"
                onClick={() => handleCasRedirect(false)}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#0D386B] px-4 py-3 text-sm font-semibold text-white hover:bg-[#0A2C55] active:scale-[0.99]"
              >
                <ExternalLink className="h-4 w-4" />
                使用数字大外（DLUFL-CAS）登录
              </button>

              <button
                type="button"
                onClick={() => handleCasRedirect(true)}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-[#DCE4EE] bg-white px-4 py-2.5 text-sm font-medium text-[#0D223D] hover:bg-[#F3F6FA]"
              >
                <RefreshCw className="h-4 w-4 text-[#4D627A]" />
                强制重新输入账号密码（切换账号）
              </button>

              {authConfig?.callbackUrl && (
                <p className="text-center text-xs text-[#64748B]">
                  回调地址：<span className="font-mono">{authConfig.callbackUrl}</span>
                </p>
              )}
            </div>
          ) : (
            <form onSubmit={handleIntranetSubmit} className="space-y-4">
              <p className="text-xs leading-relaxed text-[#4D627A]">
                当客户端位于校园内网或无法直接打开外网 CAS 页面时，可通过 HTTPS 将凭据提交至后端服务端安全完成 CAS 协议编码并换取 ST 票据（前端不暴露任何加密脚本）。
              </p>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-[#0D223D]">学号 / 工号</label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="请输入数字大外学号"
                  className="w-full rounded-lg border border-[#CBD5E1] px-3.5 py-2.5 text-sm outline-none focus:border-[#0D386B] focus:ring-2 focus:ring-[#0D386B]/15"
                  required
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-[#0D223D]">统一身份密码</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="通过 HTTPS 提交至服务端安全认证"
                  className="w-full rounded-lg border border-[#CBD5E1] px-3.5 py-2.5 text-sm outline-none focus:border-[#0D386B] focus:ring-2 focus:ring-[#0D386B]/15"
                  required
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#0D386B] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#0A2C55] disabled:opacity-60"
              >
                <Lock className="h-4 w-4" />
                {loading ? '正在通过 CAS 验证...' : '加密验证并登录'}
              </button>
            </form>
          )}

          {authConfig?.mockMode && (
            <div className="mt-5 border-t border-dashed border-[#CBD5E1] pt-4">
              <p className="mb-2.5 text-xs font-medium text-[#DF7900]">
                本地演练模式已启用（ICSPACE_MOCK_MODE=true）
              </p>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  value={demoStudentId}
                  onChange={(e) => setDemoStudentId(e.target.value)}
                  placeholder="演练学号"
                  className="rounded-lg border border-[#CBD5E1] px-3 py-1.5 text-xs"
                />
                <input
                  type="text"
                  value={demoName}
                  onChange={(e) => setDemoName(e.target.value)}
                  placeholder="演练姓名"
                  className="rounded-lg border border-[#CBD5E1] px-3 py-1.5 text-xs"
                />
              </div>
              <button
                type="button"
                onClick={handleDemoLogin}
                disabled={loading}
                className="mt-2.5 w-full rounded-lg border border-[#DF7900]/40 bg-[#FFF7ED] px-3 py-2 text-xs font-semibold text-[#B45309] hover:bg-[#FFEDD5]"
              >
                使用演练账号快速体验全流程
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

interface IcspBindModalProps {
  open: boolean;
  onClose: () => void;
  user: UserProfile | null;
  onUpdated: () => Promise<void>;
}

export const IcspBindModal: React.FC<IcspBindModalProps> = ({
  open,
  onClose,
  user,
  onUpdated,
}) => {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  if (!open || !user) return null;

  const handleBind = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    setLoading(true);
    try {
      const res = await api.auth.bindIcspace(password);
      setSuccessMsg(res.message);
      setPassword('');
      await onUpdated();
    } catch (err: any) {
      setError(err?.message || '授权验证失败');
    } finally {
      setLoading(false);
    }
  };

  const handleUnbind = async () => {
    setError(null);
    setSuccessMsg(null);
    setLoading(true);
    try {
      const res = await api.auth.unbindIcspace();
      setSuccessMsg(res.message);
      await onUpdated();
    } catch (err: any) {
      setError(err?.message || '解绑失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0D223D]/55 p-4 backdrop-blur-[2px]">
      <div className="w-full max-w-md rounded-xl border border-[#DCE4EE] bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-[#DCE4EE] px-6 py-4">
          <div className="flex items-center gap-2.5">
            <KeyRound className="h-5 w-5 text-[#0D386B]" />
            <h2 className="text-base font-semibold text-[#0D223D]">图书馆 ICSpace 预约授权</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-[#4D627A] hover:bg-[#F3F6FA]"
            aria-label="关闭窗口"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-6">
          <div className="rounded-lg border border-[#DCE4EE] bg-[#F8FAFC] p-3.5 text-xs leading-relaxed text-[#4D627A]">
            <p className="font-semibold text-[#0D223D]">为什么需要预约凭证授权？</p>
            <p className="mt-1">
              浏览器 CAS 跳转仅向本站返回您的学号与姓名，无法读取{' '}
              <span className="font-mono text-[#0D386B]">icspace.dlufl.edu.cn</span>{' '}
              的会话 Cookie。完成一次性授权后，系统将使用{' '}
              <strong className="text-[#0D223D]">AES-256-GCM</strong>{' '}
              加密保存凭据，用于实时拉取各区座位状态以及每天 18:01 自动定时抢座与无座轮询。
            </p>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-[#DCE4EE] px-4 py-3 text-sm">
            <div>
              <p className="font-medium text-[#0D223D]">
                {user.name}（{user.studentId}）
              </p>
              <p className="text-xs text-[#4D627A]">{user.unitName}</p>
            </div>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
                user.icspaceBound
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'bg-amber-50 text-amber-700'
              }`}
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              {user.icspaceBound ? '已授权' : '未授权'}
            </span>
          </div>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
              {error}
            </div>
          )}
          {successMsg && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700">
              {successMsg}
            </div>
          )}

          <form onSubmit={handleBind} className="space-y-3">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-[#0D223D]">
                输入数字大外密码（验证并加密授权）
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="仅用于向 icspace.dlufl.edu.cn 换取预约 Cookie"
                className="w-full rounded-lg border border-[#CBD5E1] px-3.5 py-2.5 text-sm outline-none focus:border-[#0D386B] focus:ring-2 focus:ring-[#0D386B]/15"
                required
              />
            </div>

            <div className="flex gap-2.5">
              <button
                type="submit"
                disabled={loading}
                className="flex-1 rounded-lg bg-[#0D386B] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#0A2C55] disabled:opacity-60"
              >
                {loading ? '正在验证 ICSpace...' : user.icspaceBound ? '更新授权密码' : '验证并启用自动抢座'}
              </button>
              {user.icspaceBound && (
                <button
                  type="button"
                  onClick={handleUnbind}
                  disabled={loading}
                  className="rounded-lg border border-red-200 bg-white px-3.5 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50"
                >
                  解除授权
                </button>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
