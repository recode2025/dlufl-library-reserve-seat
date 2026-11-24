import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { appConfig } from '../config/app.config';

export interface UserRow {
  id: number;
  student_id: string;
  cas_user_id: string;
  name: string;
  unit_name: string;
  id_type: string;
  email: string;
  encrypted_cas_password: string | null;
  icspace_cookies_json: string | null;
  icspace_bound: number;
  login_count: number;
  last_login_at: string;
  created_at: string;
  updated_at: string;
}

export interface ReservationRow {
  id: number;
  user_id: number;
  student_id: string;
  student_name: string;
  unit_name: string;
  area_id: string;
  area_name: string;
  dev_id: string;
  seat_name: string;
  target_date: string;
  start_time: string;
  end_time: string;
  source: 'manual' | 'scheduled' | 'polling';
  schedule_id: number | null;
  status: 'success' | 'failed' | 'cancelled';
  remote_resv_id: string | null;
  message: string | null;
  created_at: string;
}

export interface ScheduledTaskRow {
  id: number;
  user_id: number;
  name: string;
  enabled: number;
  area_ids_json: string;
  preferred_seats_json: string;
  seat_min: number;
  seat_max: number;
  start_time: string;
  end_time: string;
  min_free_rate: number;
  force_full_range: number;
  trigger_time: string;
  target_day_offset: number;
  weekdays_json: string;
  is_recurring: number;
  poll_interval_sec: number;
  max_poll_minutes: number;
  status: 'idle' | 'polling' | 'succeeded' | 'paused' | 'failed';
  active_target_date: string | null;
  last_triggered_date: string | null;
  poll_started_at: string | null;
  poll_attempts: number;
  last_message: string | null;
  last_seat_name: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskLogRow {
  id: number;
  task_id: number;
  level: 'info' | 'warn' | 'success' | 'error';
  message: string;
  created_at: string;
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  public db!: DatabaseSync;

  constructor() {
    this.init(appConfig.databasePath);
  }

  init(dbPath: string) {
    if (this.db) return;
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
    this.logger.log(`SQLite initialized at ${dbPath}`);
  }

  onModuleInit() {
    this.init(appConfig.databasePath);
  }

  onModuleDestroy() {
    if (this.db) {
      this.db.close();
    }
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT UNIQUE NOT NULL,
        cas_user_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        unit_name TEXT NOT NULL,
        id_type TEXT NOT NULL DEFAULT '1',
        email TEXT NOT NULL,
        encrypted_cas_password TEXT,
        icspace_cookies_json TEXT,
        icspace_bound INTEGER NOT NULL DEFAULT 0,
        login_count INTEGER NOT NULL DEFAULT 1,
        last_login_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cas_login_tokens (
        token TEXT PRIMARY KEY,
        cookie TEXT NOT NULL,
        lt TEXT NOT NULL,
        execution TEXT NOT NULL,
        service_url TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        student_id TEXT NOT NULL,
        student_name TEXT NOT NULL,
        unit_name TEXT NOT NULL,
        area_id TEXT NOT NULL,
        area_name TEXT NOT NULL,
        dev_id TEXT NOT NULL,
        seat_name TEXT NOT NULL,
        target_date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        schedule_id INTEGER,
        status TEXT NOT NULL DEFAULT 'success',
        remote_resv_id TEXT,
        message TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_reservations_student ON reservations(student_id);
      CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations(status);
      CREATE INDEX IF NOT EXISTS idx_reservations_date ON reservations(target_date);

      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        area_ids_json TEXT NOT NULL,
        preferred_seats_json TEXT NOT NULL DEFAULT '[]',
        seat_min INTEGER NOT NULL DEFAULT 1,
        seat_max INTEGER NOT NULL DEFAULT 200,
        start_time TEXT NOT NULL DEFAULT '08:30',
        end_time TEXT NOT NULL DEFAULT '22:00',
        min_free_rate INTEGER NOT NULL DEFAULT 80,
        force_full_range INTEGER NOT NULL DEFAULT 0,
        trigger_time TEXT NOT NULL DEFAULT '18:01',
        target_day_offset INTEGER NOT NULL DEFAULT 1,
        weekdays_json TEXT NOT NULL DEFAULT '[0,1,2,3,4,5,6]',
        is_recurring INTEGER NOT NULL DEFAULT 1,
        poll_interval_sec INTEGER NOT NULL DEFAULT 5,
        max_poll_minutes INTEGER NOT NULL DEFAULT 180,
        status TEXT NOT NULL DEFAULT 'idle',
        active_target_date TEXT,
        last_triggered_date TEXT,
        poll_started_at TEXT,
        poll_attempts INTEGER NOT NULL DEFAULT 0,
        last_message TEXT,
        last_seat_name TEXT,
        last_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_user ON scheduled_tasks(user_id);
      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status ON scheduled_tasks(status);

      CREATE TABLE IF NOT EXISTS task_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
        level TEXT NOT NULL DEFAULT 'info',
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id, id DESC);

      CREATE TABLE IF NOT EXISTS site_metrics (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS visit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        visitor_hash TEXT NOT NULL,
        path TEXT NOT NULL,
        visit_date TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_visit_logs_date ON visit_logs(visit_date);
    `);

    const now = new Date().toISOString();
    const upsertMetric = this.db.prepare(
      `INSERT OR IGNORE INTO site_metrics (key, value, updated_at) VALUES (?, 0, ?)`,
    );
    upsertMetric.run('total_visits', now);
    upsertMetric.run('total_successful_bookings', now);
  }

  incrementMetric(key: string, delta = 1): number {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO site_metrics (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = value + excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, delta, now);
    const row = this.db.prepare(`SELECT value FROM site_metrics WHERE key = ?`).get(key) as
      | { value: number }
      | undefined;
    return row?.value ?? 0;
  }

  getMetric(key: string): number {
    const row = this.db.prepare(`SELECT value FROM site_metrics WHERE key = ?`).get(key) as
      | { value: number }
      | undefined;
    return row?.value ?? 0;
  }
}
