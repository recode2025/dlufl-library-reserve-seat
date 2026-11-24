import type {
  AuthConfigResponse,
  AuthMeResponse,
  CardQueryResponse,
  LeaderboardCard,
  LibraryArea,
  MyReservation,
  OverviewStats,
  ReleaseCountdown,
  ScheduledTask,
  SeatsResponse,
  TaskLog,
} from './types';

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers as Record<string, string>),
  };

  const resp = await fetch(url, {
    ...options,
    credentials: 'include',
    headers,
  });

  const text = await resp.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }

  if (!resp.ok) {
    const msg =
      (Array.isArray(data?.message) ? data.message.join('；') : data?.message) ||
      `请求失败 (HTTP ${resp.status})`;
    throw new Error(msg);
  }

  return data as T;
}

export const api = {
  auth: {
    me: () => request<AuthMeResponse>('/api/auth/me'),
    config: () => request<AuthConfigResponse>('/api/auth/config'),
    logout: (casLogout = true) =>
      request<{ success: boolean; casLogoutUrl: string | null }>('/api/auth/logout', {
        method: 'POST',
        body: JSON.stringify({ casLogout }),
      }),
    getIntranetToken: () =>
      request<{ success: boolean; token: string; lt: string; execution: string; callbackUrl: string }>(
        '/api/auth/cas/token',
      ),
    submitIntranetLogin: (payload: {
      token: string;
      rsa: string;
      ul: number;
      pl: number;
      execution: string;
    }) =>
      request<{ success: boolean; ticket: string; redirectUrl: string }>('/api/auth/cas/submit', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    bindIcspace: (password: string) =>
      request<{
        success: boolean;
        message: string;
        icspaceUser: { accNo: string; trueName: string; pid: string };
      }>('/api/auth/icspace/bind', {
        method: 'POST',
        body: JSON.stringify({ password }),
      }),
    unbindIcspace: () =>
      request<{ success: boolean; message: string }>('/api/auth/icspace/bind', {
        method: 'DELETE',
      }),
    demoLogin: (payload?: { studentId?: string; name?: string; unitName?: string }) =>
      request<{ success: boolean }>('/api/auth/demo-login', {
        method: 'POST',
        body: JSON.stringify(payload || {}),
      }),
  },

  library: {
    areas: () =>
      request<{ areas: LibraryArea[]; countdown: ReleaseCountdown }>('/api/library/areas'),
    seats: (params: { areaId: string; date: string; startTime: string; endTime: string }) => {
      const qs = new URLSearchParams(params).toString();
      return request<SeatsResponse>(`/api/library/seats?${qs}`);
    },
    reserve: (payload: {
      areaId: string;
      devId: string;
      seatName: string;
      targetDate: string;
      startTime: string;
      endTime: string;
    }) =>
      request<{ success: boolean; message: string; reservationId?: number }>(
        '/api/library/reserve',
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      ),
    myReservations: () =>
      request<{ reservations: MyReservation[] }>('/api/library/reservations/mine'),
    schedules: () =>
      request<{ countdown: ReleaseCountdown; tasks: ScheduledTask[] }>('/api/library/schedules'),
    createSchedule: (payload: Record<string, any>) =>
      request<{ success: boolean; task: ScheduledTask }>('/api/library/schedules', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    updateSchedule: (id: number, payload: Record<string, any>) =>
      request<{ success: boolean; task: ScheduledTask }>(`/api/library/schedules/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    deleteSchedule: (id: number) =>
      request<{ success: boolean }>(`/api/library/schedules/${id}`, { method: 'DELETE' }),
    triggerSchedule: (id: number, targetDate?: string) =>
      request<{ success: boolean; task: ScheduledTask }>(`/api/library/schedules/${id}/trigger`, {
        method: 'POST',
        body: JSON.stringify(targetDate ? { targetDate } : {}),
      }),
    stopSchedule: (id: number) =>
      request<{ success: boolean; task: ScheduledTask }>(`/api/library/schedules/${id}/stop`, {
        method: 'POST',
      }),
    scheduleLogs: (id: number) =>
      request<{ logs: TaskLog[] }>(`/api/library/schedules/${id}/logs`),
  },

  stats: {
    recordVisit: (path = '/') =>
      request<{ totalVisits: number; todayVisits: number; totalSuccessfulBookings: number }>(
        '/api/stats/visit',
        {
          method: 'POST',
          body: JSON.stringify({ path }),
        },
      ),
    overview: () => request<OverviewStats>('/api/stats/overview'),
    queryCard: (query: string) => {
      const qs = new URLSearchParams({ query }).toString();
      return request<CardQueryResponse>(`/api/stats/card?${qs}`);
    },
    leaderboard: () => request<{ cards: LeaderboardCard[] }>('/api/stats/cards/leaderboard'),
  },
};
