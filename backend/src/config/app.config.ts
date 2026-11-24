import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export interface LibraryAreaConfig {
  id: string;
  name: string;
  floor: string;
  description: string;
  defaultSeatCount: number;
  openTime: string;
  closeTime: string;
}

export const LIBRARY_AREAS: LibraryAreaConfig[] = [
  {
    id: '100475785',
    name: '二楼东区',
    floor: '2F 东侧',
    description: '采光充沛，靠窗单人研修位集中，适合长时间自习与备考。',
    defaultSeatCount: 96,
    openTime: '08:00',
    closeTime: '22:00',
  },
  {
    id: '100475787',
    name: '二楼中区',
    floor: '2F 中庭',
    description: '综合阅览主区，电源插座覆盖率高，进出便捷。',
    defaultSeatCount: 112,
    openTime: '08:00',
    closeTime: '22:00',
  },
  {
    id: '100475789',
    name: '二楼西区',
    floor: '2F 西侧',
    description: '安静研修区，人流较少，适合专注阅读与论文写作。',
    defaultSeatCount: 88,
    openTime: '08:00',
    closeTime: '22:00',
  },
  {
    id: '109342010',
    name: '六楼电子阅览室',
    floor: '6F 电子区',
    description: '高层视野开阔，配备稳定电源与网络环境，适合电脑办公学习。',
    defaultSeatCount: 64,
    openTime: '08:00',
    closeTime: '22:00',
  },
];

function parseList(raw: string | undefined, fallback: string[]): string[] {
  if (!raw || !raw.trim()) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const appConfig = {
  port: Number(process.env.PORT || 18301),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  frontendUrl: (process.env.FRONTEND_URL || '').replace(/\/+$/, ''),
  jwtSecret: process.env.JWT_SECRET || 'dlufl-library-jwt-secret-dev-2026',
  credentialEncryptionKey:
    process.env.CREDENTIAL_ENCRYPTION_KEY || 'dlufl-library-aes-key-32-chars-min-2026',
  databasePath: process.env.DATABASE_PATH || path.resolve(process.cwd(), 'data', 'library.db'),
  mockMode: String(process.env.ICSPACE_MOCK_MODE || 'false').toLowerCase() === 'true',
  sessionCookieName: 'dlufl_lib_session',
  returnToCookieName: 'dlufl_cas_return_to',
  cas: {
    serverUrl: (process.env.CAS_SERVER_URL || 'https://cas.dlufl.edu.cn').replace(/\/+$/, ''),
    loginPath: process.env.CAS_LOGIN_PATH || '/cas/login',
    logoutPath: process.env.CAS_LOGOUT_PATH || '/cas/logout',
    validatePath: process.env.CAS_VALIDATE_PATH || '/cas/proxyValidate',
    emailDomain: process.env.CAS_EMAIL_DOMAIN || 'student.dlufl.edu.cn',
    intranetCidrs: parseList(process.env.INTRANET_CIDRS, ['192.168.0.0/16', '172.23.48.0/21']),
    requiredCasFields: parseList(process.env.REQUIRED_CAS_FIELDS, [
      'user_id',
      'unit_name',
      'id_number',
      'user_name',
      'id_type',
    ]),
    tokenTtlMs: Number(process.env.CAS_TOKEN_TTL_MS || 5 * 60 * 1000),
    axiosTimeoutMs: Number(process.env.CAS_AXIOS_TIMEOUT_MS || 15000),
    userAgent:
      process.env.CAS_USER_AGENT ||
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  },
  icspace: {
    host: (process.env.ICSPACE_HOST || 'https://icspace.dlufl.edu.cn').replace(/\/+$/, ''),
    areas: LIBRARY_AREAS,
  },
};
