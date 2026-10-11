import type BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  AccountConnectionSchema,
  DeliveryModeSchema,
  type AccountConnection,
} from '../../domain/index.js';
import type {
  AccountConnectionSource,
  PlatformAccountRuntime,
} from '../platforms/adapter-runtime.js';
import type { CapabilityContext } from '../platforms/capability-registry.js';
import type { SecretVault } from './secret-vault.js';

const probeAvailabilitySchema = z.enum(['AVAILABLE', 'UNAVAILABLE', 'UNKNOWN']);
const capabilityContextSchema = z.object({
  qualifications: z.array(z.string().min(1)),
  scopes: z.array(z.string().min(1)),
  probes: z.object({
    directApi: probeAvailabilitySchema,
    remoteDraft: probeAvailabilitySchema,
    assistedBrowser: probeAvailabilitySchema,
  }).strict(),
}).strict();

const credentialsSchema = z.record(
  z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/),
  z.string().min(1),
);

const saveAccountSchema = z.object({
  id: z.string().min(1).optional(),
  platform: z.string().min(1),
  displayName: z.string().trim().min(1).max(120),
  externalAccountId: z.string().min(1).nullable(),
  deliveryMode: DeliveryModeSchema,
  credentials: credentialsSchema,
  capabilityContext: capabilityContextSchema.optional(),
}).strict();

export type SaveAccountInput = z.input<typeof saveAccountSchema>;

export interface AccountSummary extends AccountConnection {
  credentialNames: string[];
  capabilityContext: CapabilityContext;
}

interface AccountRow {
  id: string;
  platform: string;
  external_account_id: string | null;
  display_name: string;
  delivery_mode: string;
  credential_ref: string | null;
  enabled: number;
  capabilities_json: string;
  capabilities_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

const emptyCapabilityContext = (): CapabilityContext => ({
  qualifications: [],
  scopes: [],
  probes: {
    directApi: 'UNKNOWN',
    remoteDraft: 'UNKNOWN',
    assistedBrowser: 'AVAILABLE',
  },
});

export class AccountRepository implements AccountConnectionSource {
  public constructor(
    private readonly database: BetterSqlite3.Database,
    private readonly vault: SecretVault,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  save(inputValue: SaveAccountInput): AccountSummary {
    const input = saveAccountSchema.parse(inputValue);
    const id = input.id ?? this.createId();
    const timestamp = this.now().toISOString();
    const existingCreatedAt = this.database.prepare(
      'SELECT created_at FROM account_connections WHERE id = ?',
    ).pluck().get(id) as string | undefined;
    const context = input.capabilityContext ?? emptyCapabilityContext();
    const credentialNames = Object.keys(input.credentials).sort();

    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO account_connections (
          id, platform, display_name, credential_ref, capabilities_json, status,
          created_at, updated_at, external_account_id, delivery_mode, enabled,
          capabilities_checked_at
        ) VALUES (?, ?, ?, ?, ?, 'CONNECTED', ?, ?, ?, ?, 1, ?)
        ON CONFLICT(id) DO UPDATE SET
          platform = excluded.platform,
          display_name = excluded.display_name,
          credential_ref = excluded.credential_ref,
          capabilities_json = excluded.capabilities_json,
          status = excluded.status,
          updated_at = excluded.updated_at,
          external_account_id = excluded.external_account_id,
          delivery_mode = excluded.delivery_mode,
          enabled = excluded.enabled,
          capabilities_checked_at = excluded.capabilities_checked_at
      `).run(
        id,
        input.platform,
        input.displayName,
        credentialNames.length === 0 ? null : `safeStorage:${id}`,
        JSON.stringify(context),
        existingCreatedAt ?? timestamp,
        timestamp,
        input.externalAccountId,
        input.deliveryMode,
        input.capabilityContext === undefined ? null : timestamp,
      );

      const existingNames = this.database.prepare(
        'SELECT name FROM secrets WHERE account_id = ?',
      ).pluck().all(id) as string[];
      for (const name of existingNames) {
        if (!credentialNames.includes(name)) this.vault.delete(id, name);
      }
      for (const [name, value] of Object.entries(input.credentials)) {
        this.vault.set(id, name, value);
      }
    })();

    return this.requireSummary(id);
  }

  list(): AccountSummary[] {
    const rows = this.database.prepare(`
      SELECT id, platform, external_account_id, display_name, delivery_mode,
             credential_ref, enabled, capabilities_json, capabilities_checked_at,
             created_at, updated_at
      FROM account_connections ORDER BY created_at, id
    `).all() as AccountRow[];
    return rows.map((row) => this.toSummary(row));
  }

  async getAccount(accountId: string): Promise<PlatformAccountRuntime | null> {
    const row = this.getRow(accountId);
    if (row === undefined || row.enabled !== 1) return null;
    const names = this.credentialNames(accountId);
    const credentials: Record<string, string> = {};
    for (const name of names) {
      const value = this.vault.get(accountId, name);
      if (value !== undefined) credentials[name] = value;
    }
    return {
      accountId,
      credentials,
      capabilityContext: capabilityContextSchema.parse(JSON.parse(row.capabilities_json)),
    };
  }

  private requireSummary(id: string): AccountSummary {
    const row = this.getRow(id);
    if (row === undefined) throw new Error(`Unknown account: ${id}`);
    return this.toSummary(row);
  }

  private getRow(id: string): AccountRow | undefined {
    return this.database.prepare(`
      SELECT id, platform, external_account_id, display_name, delivery_mode,
             credential_ref, enabled, capabilities_json, capabilities_checked_at,
             created_at, updated_at
      FROM account_connections WHERE id = ?
    `).get(id) as AccountRow | undefined;
  }

  private credentialNames(accountId: string): string[] {
    return this.database.prepare(
      'SELECT name FROM secrets WHERE account_id = ? ORDER BY name',
    ).pluck().all(accountId) as string[];
  }

  private toSummary(row: AccountRow): AccountSummary {
    const account = AccountConnectionSchema.parse({
      id: row.id,
      platform: row.platform,
      externalAccountId: row.external_account_id,
      displayName: row.display_name,
      deliveryMode: row.delivery_mode,
      credentialRef: row.credential_ref,
      enabled: row.enabled === 1,
      capabilitiesCheckedAt: row.capabilities_checked_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
    return {
      ...account,
      credentialNames: this.credentialNames(row.id),
      capabilityContext: capabilityContextSchema.parse(JSON.parse(row.capabilities_json)),
    };
  }
}
