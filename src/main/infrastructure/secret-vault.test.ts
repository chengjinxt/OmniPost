import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from './database.js';
import { SecretVault, SecretVaultUnavailableError, type EncryptionProvider } from './secret-vault.js';

class FakeEncryptionProvider implements EncryptionProvider {
  public constructor(private readonly available = true) {}

  isEncryptionAvailable(): boolean {
    return this.available;
  }

  encryptString(value: string): Buffer {
    return Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`);
  }

  decryptString(value: Buffer): string {
    return Buffer.from(value.toString().replace('encrypted:', ''), 'base64').toString();
  }
}

describe('SecretVault', () => {
  let database: BetterSqlite3.Database;

  beforeEach(() => {
    database = openDatabase(':memory:');
    const now = '2026-10-12T00:00:00.000Z';
    database.prepare(`
      INSERT INTO account_connections (
        id, platform, display_name, credential_ref, capabilities_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('account-1', 'WECHAT', '公众号', null, '{}', 'CONNECTED', now, now);
  });

  afterEach(() => {
    database.close();
  });

  it('stores only encrypted bytes and can update a secret', () => {
    const vault = new SecretVault(database, new FakeEncryptionProvider());

    vault.set('account-1', 'access_token', 'first-token');
    vault.set('account-1', 'access_token', 'rotated-token');

    const stored = database
      .prepare('SELECT ciphertext FROM secrets WHERE account_id = ? AND name = ?')
      .pluck()
      .get('account-1', 'access_token') as Buffer;

    expect(stored.toString()).not.toContain('rotated-token');
    expect(vault.get('account-1', 'access_token')).toBe('rotated-token');
    expect(database.prepare('SELECT COUNT(*) FROM secrets').pluck().get()).toBe(1);
  });

  it('removes a secret without exposing its previous value', () => {
    const vault = new SecretVault(database, new FakeEncryptionProvider());
    vault.set('account-1', 'app_secret', 'sensitive');

    expect(vault.delete('account-1', 'app_secret')).toBe(true);
    expect(vault.get('account-1', 'app_secret')).toBeUndefined();
  });

  it('refuses persistence when operating-system encryption is unavailable', () => {
    const vault = new SecretVault(database, new FakeEncryptionProvider(false));

    expect(() => vault.set('account-1', 'access_token', 'plaintext')).toThrow(SecretVaultUnavailableError);
    expect(database.prepare('SELECT COUNT(*) FROM secrets').pluck().get()).toBe(0);
  });
});
