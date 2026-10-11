import type BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';

import type { AiGenerationRecord, AiProviderConfig } from './ai-variant-generator.js';
import { SecretVaultUnavailableError, type EncryptionProvider } from '../infrastructure/secret-vault.js';

const SaveAiProfileSchema = z.object({
  baseUrl: z.string().url(),
  baseUrlId: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1).max(200),
  endpoint: z.enum(['RESPONSES', 'CHAT_COMPLETIONS']),
  promptVersion: z.string().trim().min(1).max(120),
  apiKey: z.string().min(1).nullable(),
}).strict();

export type SaveAiProfileInput = z.input<typeof SaveAiProfileSchema>;

export interface AiProfileSummary {
  configured: true;
  baseUrl: string;
  baseUrlId: string;
  model: string;
  endpoint: 'RESPONSES' | 'CHAT_COMPLETIONS';
  promptVersion: string;
  hasApiKey: boolean;
  updatedAt: string;
}

export interface AiProfileRuntime {
  config: AiProviderConfig;
  apiKey: string | undefined;
  promptVersion: string;
}

interface AiProfileRow {
  base_url: string;
  base_url_id: string;
  model: string;
  endpoint: 'RESPONSES' | 'CHAT_COMPLETIONS';
  prompt_version: string;
  api_key_ciphertext: Buffer | null;
  updated_at: string;
}

export class AiProfileRepository {
  constructor(
    private readonly database: BetterSqlite3.Database,
    private readonly encryption: EncryptionProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  save(inputValue: SaveAiProfileInput): AiProfileSummary {
    const input = SaveAiProfileSchema.parse(inputValue);
    let ciphertext: Buffer | null = null;
    if (input.apiKey !== null) {
      if (!this.encryption.isEncryptionAvailable()) throw new SecretVaultUnavailableError();
      ciphertext = this.encryption.encryptString(input.apiKey);
    }
    const timestamp = this.now().toISOString();
    this.database.prepare(`
      INSERT INTO ai_profiles (
        id, base_url, base_url_id, model, endpoint, prompt_version,
        api_key_ciphertext, created_at, updated_at
      ) VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        base_url = excluded.base_url,
        base_url_id = excluded.base_url_id,
        model = excluded.model,
        endpoint = excluded.endpoint,
        prompt_version = excluded.prompt_version,
        api_key_ciphertext = excluded.api_key_ciphertext,
        updated_at = excluded.updated_at
    `).run(
      input.baseUrl,
      input.baseUrlId,
      input.model,
      input.endpoint,
      input.promptVersion,
      ciphertext,
      timestamp,
      timestamp,
    );
    return this.getSummary() as AiProfileSummary;
  }

  getSummary(): AiProfileSummary | null {
    const row = this.getRow();
    if (row === undefined) return null;
    return {
      configured: true,
      baseUrl: row.base_url,
      baseUrlId: row.base_url_id,
      model: row.model,
      endpoint: row.endpoint,
      promptVersion: row.prompt_version,
      hasApiKey: row.api_key_ciphertext !== null,
      updatedAt: row.updated_at,
    };
  }

  getRuntime(): AiProfileRuntime | null {
    const row = this.getRow();
    if (row === undefined) return null;
    let apiKey: string | undefined;
    if (row.api_key_ciphertext !== null) {
      if (!this.encryption.isEncryptionAvailable()) throw new SecretVaultUnavailableError();
      apiKey = this.encryption.decryptString(row.api_key_ciphertext);
    }
    return {
      config: {
        baseUrl: row.base_url,
        baseUrlId: row.base_url_id,
        model: row.model,
        endpoint: row.endpoint,
        headers: {},
        ...(apiKey === undefined ? {} : { apiKey }),
      },
      apiKey,
      promptVersion: row.prompt_version,
    };
  }

  recordGeneration(record: AiGenerationRecord): void {
    this.database.prepare(`
      INSERT INTO ai_generation_records (
        variant_id, model, base_url_id, prompt_version, request_hash,
        response_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.variantId,
      record.model,
      record.baseUrlId,
      record.promptVersion,
      record.requestHash,
      record.responseHash,
      record.createdAt,
    );
  }

  private getRow(): AiProfileRow | undefined {
    return this.database.prepare(`
      SELECT base_url, base_url_id, model, endpoint, prompt_version,
             api_key_ciphertext, updated_at
      FROM ai_profiles WHERE id = 'default'
    `).get() as AiProfileRow | undefined;
  }
}
