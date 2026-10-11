import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';

export interface EncryptionProvider {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export class SecretVaultUnavailableError extends Error {
  public constructor() {
    super('Operating-system credential encryption is unavailable.');
    this.name = 'SecretVaultUnavailableError';
  }
}

export class SecretVault {
  public constructor(
    private readonly database: BetterSqlite3.Database,
    private readonly encryption: EncryptionProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  set(accountId: string, name: string, plaintext: string): void {
    this.assertAvailable();
    const timestamp = this.now().toISOString();
    const ciphertext = this.encryption.encryptString(plaintext);

    this.database.prepare(`
      INSERT INTO secrets (id, account_id, name, ciphertext, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (account_id, name) DO UPDATE SET
        ciphertext = excluded.ciphertext,
        updated_at = excluded.updated_at
    `).run(randomUUID(), accountId, name, ciphertext, timestamp, timestamp);
  }

  get(accountId: string, name: string): string | undefined {
    const ciphertext = this.database
      .prepare('SELECT ciphertext FROM secrets WHERE account_id = ? AND name = ?')
      .pluck()
      .get(accountId, name) as Buffer | undefined;

    if (ciphertext === undefined) {
      return undefined;
    }

    this.assertAvailable();
    return this.encryption.decryptString(ciphertext);
  }

  delete(accountId: string, name: string): boolean {
    const result = this.database
      .prepare('DELETE FROM secrets WHERE account_id = ? AND name = ?')
      .run(accountId, name);

    return result.changes > 0;
  }

  private assertAvailable(): void {
    if (!this.encryption.isEncryptionAvailable()) {
      throw new SecretVaultUnavailableError();
    }
  }
}
