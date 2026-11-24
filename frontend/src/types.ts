export interface UserProfile {
  id: number;
  studentId: string;
  casUserId: string;
  name: string;
  unitName: string;
  idType: string;
  email: string;
  icspaceBound: boolean;
  loginCount: number;
  lastLoginAt: string;
  createdAt: string;
}

export interface AuthMeResponse {
  authenticated: boolean;
  user: UserProfile | null;
  authProvider: string | null;
  mockMode: boolean;
}

export interface AuthConfigResponse {
  casServerUrl: string;
  callbackUrl: string;
  isInternalNetwork: boolean;
  mockMode: boolean;
}

export interface LibraryArea {
  id: string;
  name: string;
  floor: string;
  description: string;
  defaultSeatCount: number;
  openTime: string;
  closeTime: string;
}

export interface ReleaseCountdown {
  serverTime: string;
  phase: 'before_release' | 'release_window' | 'after_grab';
  nextReleaseAt: string;
  nextGrabAt: string;
  secondsToRelease: number;
  secondsToGrab: number;
  targetBookingDate: string;
}

export interface TimeSlot {
  start: number;
  end: number;
  startStr: string;
  endStr: string;
  durationMin: number;
}

export interface SeatInfo {
  devId: string;
  devName: string;
  seatNumber: number;
  areaId: string;
  areaName: string;
  status: 'free' | 'partial' | 'occupied' | 'unreleased';
  freeRate: number;
  longestFreeSlot: TimeSlot | null;
  freeSlots: TimeSlot[];
  busySlots: TimeSlot[];
}

export interface BatchReleaseStatus {
  state: 'open' | 'unreleased' | 'expired' | 'closed';
  bookable: boolean;
  releaseAt?: string;
  message: string;
}

export interface SeatsResponse {
  area: LibraryArea;
  targetDate: string;
  startTime: string;
  endTime: string;
  effectiveStartTime?: string;
  effectiveEndTime?: string;
  timeCalibrated?: boolean;
  isLive: boolean;
  batchStatus?: BatchReleaseStatus;
  notice?: string;
  summary: {
    total: number;
    free: number;
    partial: number;
    occupied: number;
    unreleased: number;
  };
  seats: SeatInfo[];
}

export interface TaskLog {
  id: number;
  task_id: number;
  level: 'info' | 'warn' | 'success' | 'error';
  message: string;
  created_at: string;
}

export interface ScheduledTask {
  id: number;
  name: string;
  enabled: boolean;
  areaIds: string[];
  areas: Array<{ id: string; name: string }>;
  preferredSeats: number[];
  seatMin: number;
  seatMax: number;
  startTime: string;
  endTime: string;
  minFreeRate: number;
  forceFullRange: boolean;
  triggerTime: string;
  targetDayOffset: number;
  weekdays: number[];
  isRecurring: boolean;
  pollIntervalSec: number;
  maxPollMinutes: number;
  status: 'idle' | 'polling' | 'succeeded' | 'paused' | 'failed';
  activeTargetDate: string | null;
  lastTriggeredDate: string | null;
  pollStartedAt: string | null;
  pollAttempts: number;
  lastMessage: string | null;
  lastSeatName: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  recentLogs: TaskLog[];
}

export interface OverviewStats {
  totalSuccessfulBookings: number;
  todaySuccessfulBookings: number;
  totalVisits: number;
  todayVisits: number;
  activePollingTasks: number;
  activeSchedules: number;
  registeredUsers: number;
  countdown: ReleaseCountdown;
  areaDistribution: Array<{
    areaId: string;
    areaName: string;
    floor: string;
    successCount: number;
  }>;
  recentSuccesses: Array<{
    id: number;
    studentName: string;
    unitName: string;
    areaName: string;
    seatName: string;
    targetDate: string;
    startTime: string;
    endTime: string;
    source: 'manual' | 'scheduled' | 'polling';
    createdAt: string;
  }>;
}

export interface ReservationCard {
  studentId: string;
  name: string;
  fullNameVisible: boolean;
  unitName: string;
  cardTier: {
    code: string;
    label: string;
    nextTarget: number;
  };
  totalSuccess: number;
  thisMonthSuccess: number;
  thisWeekSuccess: number;
  manualSuccess: number;
  scheduledSuccess: number;
  pollingSuccess: number;
  totalAttempts: number;
  successRate: number;
  favoriteArea: string;
  activeDays: number;
  lastSuccessAt: string | null;
  areaBreakdown: Array<{ areaId: string; areaName: string; count: number }>;
  recentRecords: Array<{
    id: number;
    areaId: string;
    areaName: string;
    seatName: string;
    targetDate: string;
    startTime: string;
    endTime: string;
    source: 'manual' | 'scheduled' | 'polling';
    createdAt: string;
  }>;
}

export interface CardQueryResponse {
  found: boolean;
  query: string;
  message?: string;
  card: ReservationCard | null;
}

export interface LeaderboardCard {
  rank: number;
  studentId: string;
  rawQueryKey: string;
  name: string;
  unitName: string;
  totalSuccess: number;
  autoSuccess: number;
  lastArea: string;
  lastSeat: string;
  lastSuccessAt: string;
  tier: { code: string; label: string; nextTarget: number };
}

export interface MyReservation {
  id: number;
  areaId: string;
  areaName: string;
  devId: string;
  seatName: string;
  targetDate: string;
  startTime: string;
  endTime: string;
  source: 'manual' | 'scheduled' | 'polling';
  status: 'success' | 'failed' | 'cancelled';
  message: string | null;
  createdAt: string;
}
