import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { appConfig } from '../config/app.config';

export interface SessionJwtPayload {
  uid: number;
  studentId: string;
  casUserId: string;
  name: string;
  authProvider: 'dlufl-cas' | 'dlufl-intranet' | 'demo';
}

function getDerivedKey(): Buffer {
  return crypto
    .createHash('sha256')
    .update(appConfig.credentialEncryptionKey)
    .digest();
}

export function encryptSecret(plainText: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getDerivedKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${authTag.toString('base64')}.${encrypted.toString('base64')}`;
}

export function decryptSecret(cipherText: string): string {
  const parts = cipherText.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted payload format');
  }
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const encrypted = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getDerivedKey(), iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

export function signSessionToken(payload: SessionJwtPayload): string {
  return jwt.sign(payload, appConfig.jwtSecret, { expiresIn: '7d' });
}

export function verifySessionToken(token: string): SessionJwtPayload | null {
  try {
    return jwt.verify(token, appConfig.jwtSecret) as SessionJwtPayload;
  } catch {
    return null;
  }
}

export function hashVisitor(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 24);
}
