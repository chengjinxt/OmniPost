import { describe, expect, it, vi } from 'vitest';

import { openDatabase } from '../infrastructure/database.js';
import type { EncryptionProvider } from '../infrastructure/secret-vault.js';
import { AiProfileRepository } from './ai-profile-repository.js';

const encryption: EncryptionProvider = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`protected:${value}`, 'utf8'),
  decryptString: (value) => value.toString('utf8').replace(/^protected:/, ''),
};

describe('AiProfileRepository', () => {
  it('encrypts the API key and never returns it in the renderer summary', () => {
    const database = openDatabase(':memory:');
    const repository = new AiProfileRepository(database, encryption, () => new Date('2026-10-12T00:00:00.000Z'));

    const summary = repository.save({
      baseUrl: 'https://api.example.com/v1',
      baseUrlId: 'primary-provider',
      model: 'example-model',
      endpoint: 'RESPONSES',
      promptVersion: 'platform-v1',
      apiKey: 'top-secret-key',
    });

    expect(summary).toEqual({
      configured: true,
      baseUrl: 'https://api.example.com/v1',
      baseUrlId: 'primary-provider',
      model: 'example-model',
      endpoint: 'RESPONSES',
      promptVersion: 'platform-v1',
      hasApiKey: true,
      updatedAt: '2026-10-12T00:00:00.000Z',
    });
    const raw = database.prepare('SELECT api_key_ciphertext FROM ai_profiles WHERE id = ?').pluck().get('default') as Buffer;
    expect(raw.toString('utf8')).toBe('protected:top-secret-key');
    expect(JSON.stringify(summary)).not.toContain('top-secret-key');
    expect(repository.getRuntime()?.apiKey).toBe('top-secret-key');
    database.close();
  });

  it('refuses to persist a key when operating-system encryption is unavailable', () => {
    const database = openDatabase(':memory:');
    const unavailable = { ...encryption, isEncryptionAvailable: vi.fn(() => false) };
    const repository = new AiProfileRepository(database, unavailable);

    expect(() => repository.save({
      baseUrl: 'http://127.0.0.1:11434/v1',
      baseUrlId: 'local',
      model: 'local-model',
      endpoint: 'CHAT_COMPLETIONS',
      promptVersion: 'platform-v1',
      apiKey: 'must-not-leak',
    })).toThrow(/encryption is unavailable/i);
    expect(database.prepare('SELECT COUNT(*) FROM ai_profiles').pluck().get()).toBe(0);
    database.close();
  });
});
