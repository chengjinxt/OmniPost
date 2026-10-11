import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EncryptionProvider } from './secret-vault.js';
import { AccountRepository } from './account-repository.js';
import { openDatabase } from './database.js';
import { SecretVault } from './secret-vault.js';

class TestEncryption implements EncryptionProvider {
  isEncryptionAvailable(): boolean { return true; }
  encryptString(value: string): Buffer { return Buffer.from(`sealed:${Buffer.from(value).toString('base64')}`, 'utf8'); }
  decryptString(value: Buffer): string {
    return Buffer.from(value.toString('utf8').slice('sealed:'.length), 'base64').toString('utf8');
  }
}

describe('AccountRepository', () => {
  let database: BetterSqlite3.Database;
  let repository: AccountRepository;

  beforeEach(() => {
    database = openDatabase(':memory:');
    repository = new AccountRepository(
      database,
      new SecretVault(database, new TestEncryption(), () => new Date('2026-10-12T08:00:00.000Z')),
      () => 'account-1',
      () => new Date('2026-10-12T08:00:00.000Z'),
    );
  });

  afterEach(() => database.close());

  it('persists account metadata and stores credentials only as encrypted bytes', () => {
    const account = repository.save({
      platform: 'YOUTUBE',
      displayName: '主频道',
      externalAccountId: 'channel-1',
      deliveryMode: 'DIRECT_API',
      credentials: { accessToken: 'plain-token', refreshToken: 'refresh-token' },
    });

    expect(account).toMatchObject({
      id: 'account-1',
      bindingVersion: 1,
      platform: 'YOUTUBE',
      displayName: '主频道',
      capabilityContext: {
        qualifications: [],
        scopes: [],
        probes: {
          directApi: 'UNKNOWN',
          remoteDraft: 'UNKNOWN',
          assistedBrowser: 'AVAILABLE',
        },
      },
    });
    expect(repository.list()).toEqual([account]);
    const stored = database.prepare('SELECT ciphertext FROM secrets ORDER BY name').all() as Array<{ ciphertext: Buffer }>;
    expect(stored).toHaveLength(2);
    expect(stored.every((row) => !row.ciphertext.toString().includes('plain-token'))).toBe(true);
  });

  it('provides decrypted credentials only to the main-process adapter runtime', async () => {
    repository.save({
      platform: 'WECHAT_OFFICIAL_ACCOUNT',
      displayName: '公众号',
      externalAccountId: null,
      deliveryMode: 'REMOTE_DRAFT',
      credentials: { appId: 'wx-app', appSecret: 'wx-secret' },
      capabilityContext: {
        qualifications: ['WECHAT_VERIFIED_ENTERPRISE'],
        scopes: ['wechat.draft'],
        probes: { directApi: 'UNAVAILABLE', remoteDraft: 'AVAILABLE', assistedBrowser: 'UNKNOWN' },
      },
    });

    await expect(repository.getAccount('account-1')).resolves.toMatchObject({
      accountId: 'account-1',
      credentials: { appId: 'wx-app', appSecret: 'wx-secret' },
      capabilityContext: { scopes: ['wechat.draft'] },
    });
    expect(repository.list()[0]).not.toHaveProperty('credentials');
  });

  it('rotates secrets and removes credentials omitted from an update', async () => {
    repository.save({
      platform: 'YOUTUBE',
      displayName: '频道',
      externalAccountId: null,
      deliveryMode: 'DIRECT_API',
      credentials: { accessToken: 'old', refreshToken: 'remove-me' },
    });
    const updated = repository.save({
      id: 'account-1',
      platform: 'YOUTUBE',
      displayName: '频道',
      externalAccountId: null,
      deliveryMode: 'DIRECT_API',
      credentials: { accessToken: 'new' },
    });

    expect(updated.bindingVersion).toBe(2);
    expect(database.prepare('SELECT name FROM secrets ORDER BY name').pluck().all())
      .toEqual(['accessToken']);
    await expect(repository.getAccount('account-1')).resolves.toMatchObject({
      bindingVersion: 2,
      credentials: { accessToken: 'new' },
    });
  });
});
