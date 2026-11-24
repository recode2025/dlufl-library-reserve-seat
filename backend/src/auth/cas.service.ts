import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError, AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';
import * as setCookie from 'set-cookie-parser';
import * as xml2js from 'xml2js';
import type { Request } from 'express';
import { appConfig } from '../config/app.config';
import { DatabaseService, UserRow } from '../database/database.service';

export interface CasAttributes {
  user_id: string;
  unit_name: string;
  id_number: string;
  user_name: string;
  id_type: string;
  [key: string]: string;
}

export type CasResult<T> =
  | { success: true; data: T }
  | { success: false; message: string };

@Injectable()
export class CasService {
  private readonly logger = new Logger(CasService.name);

  constructor(private readonly dbService: DatabaseService) {}

  getRequestHeaders() {
    return {
      'User-Agent': appConfig.cas.userAgent,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    };
  }

  getCasLoginBaseUrl(): string {
    return `${appConfig.cas.serverUrl}${appConfig.cas.loginPath}`;
  }

  getCasValidateUrl(): string {
    return `${appConfig.cas.serverUrl}${appConfig.cas.validatePath}`;
  }

  getCasLoginRedirectUrl(serviceUrl: string, renew = false): string {
    const params = new URLSearchParams({ service: serviceUrl });
    if (renew) {
      params.set('renew', 'true');
    }
    return `${this.getCasLoginBaseUrl()}?${params.toString()}`;
  }

  getCasLogoutUrl(returnUrl: string): string {
    return `${appConfig.cas.serverUrl}${appConfig.cas.logoutPath}?service=${encodeURIComponent(returnUrl)}&_t=${Date.now()}`;
  }

  /**
   * 规范化外部访问 Origin，保证 /cas/login 与 /cas/proxyValidate 使用完全一致的 service URL。
   */
  getCanonicalOrigin(req: Request): string {
    if (appConfig.publicBaseUrl) {
      return appConfig.publicBaseUrl;
    }
    const rawProto = req.headers['x-forwarded-proto'];
    const proto = Array.isArray(rawProto)
      ? rawProto[0]
      : (rawProto || req.protocol || 'http').split(',')[0].trim();

    const rawHost = req.headers['x-forwarded-host'] || req.headers.host;
    const host = Array.isArray(rawHost)
      ? rawHost[0]
      : String(rawHost || `localhost:${appConfig.port}`).split(',')[0].trim();

    return `${proto}://${host}`;
  }

  getCallbackUrl(req: Request): string {
    return `${this.getCanonicalOrigin(req)}/api/auth/cas/callback`;
  }

  getFrontendBaseUrl(req: Request): string {
    if (appConfig.frontendUrl) {
      return appConfig.frontendUrl;
    }
    return this.getCanonicalOrigin(req);
  }

  sanitizeReturnTo(raw?: string): string {
    if (!raw || typeof raw !== 'string') return '/';
    const trimmed = raw.trim();
    if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return '/';
    return trimmed;
  }

  getClientIp(req: Request): string {
    const raw =
      req.headers['x-forwarded-for'] ||
      req.headers['x-real-ip'] ||
      req.ip ||
      req.socket?.remoteAddress ||
      '127.0.0.1';
    const ip = Array.isArray(raw) ? raw[0] : String(raw).split(',')[0].trim();
    return ip.replace(/^::ffff:/, '');
  }

  private ipToNumber(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    const nums = parts.map((p) => Number(p));
    if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    return nums.reduce((acc, octet) => (acc << 8) + octet, 0) >>> 0;
  }

  isInternalNetwork(ip: string): boolean {
    const ipNum = this.ipToNumber(ip);
    if (ipNum === null) return false;
    for (const cidr of appConfig.cas.intranetCidrs) {
      const [network, prefixRaw] = cidr.split('/');
      const prefixLength = parseInt(prefixRaw, 10);
      if (Number.isNaN(prefixLength) || prefixLength < 0 || prefixLength > 32) {
        continue;
      }
      const networkNum = this.ipToNumber(network);
      if (networkNum === null) continue;
      const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
      if ((ipNum & mask) === (networkNum & mask)) {
        return true;
      }
    }
    return false;
  }

  private buildCookieString(fromSetCookieHeader?: string[] | string): string {
    if (!fromSetCookieHeader) return '';
    const parsed = setCookie.parse(fromSetCookieHeader as any);
    return parsed.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  private toErrMsg(e: unknown, fallback = 'CAS request failed'): string {
    if (axios.isAxiosError(e)) {
      const ae = e as AxiosError;
      if (ae.response) return `${fallback} (HTTP ${ae.response.status})`;
      if (ae.request) return `${fallback} (无法连接 CAS 服务器)`;
      return `${fallback}: ${ae.message}`;
    }
    if (e instanceof Error) return `${fallback}: ${e.message}`;
    return fallback;
  }

  /**
   * 解析 DLUFL Neusoft CAS proxyValidate 返回的 XML（同时兼容 sso: 与 cas: 命名空间）。
   */
  async parseProxyValidateXml(xmlText: string): Promise<CasResult<{ userInfo: CasAttributes }>> {
    const parser = new xml2js.Parser({ explicitArray: false });
    let parsed: any;
    try {
      parsed = await parser.parseStringPromise(xmlText);
    } catch {
      return { success: false, message: 'Failed to parse CAS XML response.' };
    }

    const serviceResponse =
      parsed?.['sso:serviceResponse'] ||
      parsed?.['cas:serviceResponse'] ||
      parsed?.['serviceResponse'];

    const authSuccess =
      serviceResponse?.['sso:authenticationSuccess'] ||
      serviceResponse?.['cas:authenticationSuccess'] ||
      serviceResponse?.['authenticationSuccess'];

    if (!authSuccess) {
      const failure =
        serviceResponse?.['sso:authenticationFailure'] ||
        serviceResponse?.['cas:authenticationFailure'] ||
        serviceResponse?.['authenticationFailure'];
      const failText =
        typeof failure === 'string'
          ? failure.trim()
          : failure?._?.trim() || failure?.$?.code || 'Authentication not successful.';
      return { success: false, message: `CAS 票据校验失败: ${failText}` };
    }

    const userInfo: Record<string, string> = {};

    // Neusoft DLUFL format: <sso:attributes><sso:attribute name="..." value="..."/></sso:attributes>
    const rawSsoAttrs = authSuccess['sso:attributes']?.['sso:attribute'];
    if (rawSsoAttrs) {
      const attrs = Array.isArray(rawSsoAttrs) ? rawSsoAttrs : [rawSsoAttrs];
      for (const a of attrs) {
        const name = a?.['$']?.name;
        const value = a?.['$']?.value ?? (typeof a === 'string' ? a : a?._ ?? '');
        if (name) userInfo[name] = String(value);
      }
    }

    // Fallback standard CAS 2.0/3.0 attributes
    const rawCasAttrs = authSuccess['cas:attributes'] || authSuccess['attributes'];
    if (rawCasAttrs && typeof rawCasAttrs === 'object') {
      for (const [k, v] of Object.entries(rawCasAttrs)) {
        const cleanKey = k.replace(/^(cas|sso):/, '');
        if (!userInfo[cleanKey] && v !== undefined && v !== null) {
          userInfo[cleanKey] = Array.isArray(v) ? String(v[0]) : String(v);
        }
      }
    }

    const rawUser =
      authSuccess['sso:user'] || authSuccess['cas:user'] || authSuccess['user'];
    if (rawUser && typeof rawUser === 'string') {
      if (!userInfo.id_number) userInfo.id_number = rawUser.trim();
      if (!userInfo.user_id) userInfo.user_id = rawUser.trim();
    }

    for (const k of appConfig.cas.requiredCasFields) {
      if (!userInfo[k]) {
        return {
          success: false,
          message: `CAS 返回缺少必要属性: ${k}`,
        };
      }
    }

    return {
      success: true,
      data: { userInfo: userInfo as CasAttributes },
    };
  }

  /**
   * 严格参照 hydrooj-oauth-dlufl：向 /cas/proxyValidate 提交 POST (service + ticket) 验证 ST 票据。
   */
  async validateCasTicket(
    ticket: string,
    serviceUrl: string,
  ): Promise<CasResult<{ userInfo: CasAttributes }>> {
    try {
      const validateResponse: AxiosResponse = await axios.post(
        this.getCasValidateUrl(),
        new URLSearchParams({
          service: serviceUrl,
          ticket,
        }).toString(),
        {
          headers: this.getRequestHeaders(),
          timeout: appConfig.cas.axiosTimeoutMs,
        },
      );
      return await this.parseProxyValidateXml(String(validateResponse.data || ''));
    } catch (e) {
      return { success: false, message: this.toErrMsg(e, 'Validate ticket failed') };
    }
  }

  /**
   * 内网/无跳转兜底流程第 1 步：获取 CAS lt / execution 与 JSESSIONIDCAS（参照 hydrooj-oauth-dlufl）。
   */
  async getIntranetLoginTokens(
    serviceUrl: string,
  ): Promise<CasResult<{ token: string; lt: string; execution: string }>> {
    try {
      const initResponse: AxiosResponse = await axios.get(
        `${this.getCasLoginBaseUrl()}?service=${encodeURIComponent(serviceUrl)}&renew=true&_=${Date.now()}`,
        {
          headers: this.getRequestHeaders(),
          timeout: appConfig.cas.axiosTimeoutMs,
        },
      );

      const initSetCookieHeader = initResponse.headers['set-cookie'];
      if (!initSetCookieHeader) {
        return { success: false, message: 'CAS 服务器未返回 Set-Cookie' };
      }

      const initCookies = setCookie.parse(initSetCookieHeader);
      const hasSession = initCookies.some((c) => c.name.startsWith('JSESSIONIDCAS'));
      if (!hasSession) {
        return { success: false, message: 'CAS 服务器未返回 JSESSIONIDCAS 会话' };
      }

      const cookie = this.buildCookieString(initSetCookieHeader);
      const $init = cheerio.load(initResponse.data);
      const lt = String($init('#lt').val() || '');
      const execution = String($init('input[name="execution"]').val() || '');

      if (!lt || !execution) {
        return { success: false, message: '未能从 CAS 登录页提取 lt / execution 参数' };
      }

      const now = Date.now();
      const expiresAt = now + appConfig.cas.tokenTtlMs;
      const token = `${now}_${Math.random().toString(36).slice(2, 12)}`;

      this.dbService.db
        .prepare(`DELETE FROM cas_login_tokens WHERE expires_at < ?`)
        .run(now);
      this.dbService.db
        .prepare(
          `INSERT INTO cas_login_tokens (token, cookie, lt, execution, service_url, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(token, cookie, lt, execution, serviceUrl, now, expiresAt);

      return { success: true, data: { token, lt, execution } };
    } catch (e) {
      return { success: false, message: this.toErrMsg(e, '获取 CAS 登录令牌失败') };
    }
  }

  /**
   * 内网/无跳转兜底流程第 2 步：提交 DES 加密凭据换取 ST 票据（参照 hydrooj-oauth-dlufl）。
   */
  async submitIntranetLogin(payload: {
    token: string;
    rsa: string;
    ul: string;
    pl: string;
    execution: string;
  }): Promise<CasResult<{ ticket: string; serviceUrl: string }>> {
    const row = this.dbService.db
      .prepare(`SELECT * FROM cas_login_tokens WHERE token = ?`)
      .get(payload.token) as
      | {
          token: string;
          cookie: string;
          lt: string;
          execution: string;
          service_url: string;
          expires_at: number;
        }
      | undefined;

    if (!row || row.expires_at < Date.now() || row.execution !== payload.execution) {
      if (row) {
        this.dbService.db.prepare(`DELETE FROM cas_login_tokens WHERE token = ?`).run(row.token);
      }
      return { success: false, message: '登录令牌无效或已过期，请重新尝试' };
    }

    // 一次性使用，立即销毁
    this.dbService.db.prepare(`DELETE FROM cas_login_tokens WHERE token = ?`).run(row.token);

    try {
      const loginResponse: AxiosResponse = await axios.post(
        `${this.getCasLoginBaseUrl()}?service=${encodeURIComponent(row.service_url)}`,
        new URLSearchParams({
          rsa: payload.rsa,
          ul: String(payload.ul),
          pl: String(payload.pl),
          lt: row.lt,
          execution: row.execution,
          _eventId: 'submit',
        }).toString(),
        {
          headers: { ...this.getRequestHeaders(), Cookie: row.cookie },
          maxRedirects: 0,
          validateStatus: (s) => s >= 200 && s < 400,
          timeout: appConfig.cas.axiosTimeoutMs,
        },
      );

      const loginSetCookieHeader = loginResponse.headers['set-cookie'];
      const parsedLoginCookies = loginSetCookieHeader
        ? setCookie.parse(loginSetCookieHeader)
        : [];
      const hasTgc = parsedLoginCookies.some((c) => c.name.startsWith('CASTGC'));

      if (!hasTgc) {
        try {
          const $login = cheerio.load(loginResponse.data);
          const errMsg = $login('#errormsghide').text()?.trim();
          if (errMsg) return { success: false, message: errMsg };
        } catch {
          // ignore parse error
        }
        return { success: false, message: '账号或密码错误（未获得 CASTGC）' };
      }

      const newCookie = parsedLoginCookies
        .filter((c) => c.name !== 'Language')
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');

      const ticketResp: AxiosResponse = await axios.get(
        `${this.getCasLoginBaseUrl()}?service=${encodeURIComponent(row.service_url)}`,
        {
          headers: { ...this.getRequestHeaders(), Cookie: newCookie },
          maxRedirects: 0,
          validateStatus: (s) => s >= 200 && s < 400,
          timeout: appConfig.cas.axiosTimeoutMs,
        },
      );

      const location = ticketResp.headers['location'];
      const match = location ? /[?&]ticket=([^&#]*)/.exec(String(location)) : null;
      if (!match?.[1]) {
        return { success: false, message: '未能从 CAS 重定向中获取到 ticket' };
      }

      return { success: true, data: { ticket: match[1], serviceUrl: row.service_url } };
    } catch (e) {
      return { success: false, message: this.toErrMsg(e, '提交 CAS 登录失败') };
    }
  }

  /**
   * 原子级 Upsert CAS 用户：确保首次登录自动创建、第二次及后续登录平滑复用且绝不冲突。
   */
  upsertUserFromCas(userInfo: CasAttributes): UserRow {
    const now = new Date().toISOString();
    const studentId = String(userInfo.id_number).trim();
    const casUserId = String(userInfo.user_id).trim();
    const name = String(userInfo.user_name).trim();
    const unitName = String(userInfo.unit_name).trim();
    const idType = String(userInfo.id_type || '1').trim();
    const email = `${studentId}@${appConfig.cas.emailDomain}`;

    const existing = this.dbService.db
      .prepare(`SELECT * FROM users WHERE student_id = ? OR cas_user_id = ? LIMIT 1`)
      .get(studentId, casUserId) as UserRow | undefined;

    if (existing) {
      this.dbService.db
        .prepare(
          `UPDATE users
           SET student_id = ?, cas_user_id = ?, name = ?, unit_name = ?, id_type = ?, email = ?,
               login_count = login_count + 1, last_login_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(studentId, casUserId, name, unitName, idType, email, now, now, existing.id);

      this.logger.log(`CAS user re-login #${existing.login_count + 1}: ${studentId} (${name})`);
      return this.dbService.db
        .prepare(`SELECT * FROM users WHERE id = ?`)
        .get(existing.id) as unknown as UserRow;
    }

    const result = this.dbService.db
      .prepare(
        `INSERT INTO users (
           student_id, cas_user_id, name, unit_name, id_type, email,
           login_count, last_login_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(studentId, casUserId, name, unitName, idType, email, now, now, now);

    this.logger.log(`CAS user first login created: ${studentId} (${name})`);
    return this.dbService.db
      .prepare(`SELECT * FROM users WHERE id = ?`)
      .get(Number(result.lastInsertRowid)) as unknown as UserRow;
  }

  findUserById(id: number): UserRow | undefined {
    return this.dbService.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as
      | UserRow
      | undefined;
  }

  toPublicUser(user: UserRow) {
    return {
      id: user.id,
      studentId: user.student_id,
      casUserId: user.cas_user_id,
      name: user.name,
      unitName: user.unit_name,
      idType: user.id_type,
      email: user.email,
      icspaceBound: Boolean(user.icspace_bound),
      loginCount: user.login_count,
      lastLoginAt: user.last_login_at,
      createdAt: user.created_at,
    };
  }
}
