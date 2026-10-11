import { safeStorage } from 'electron';

import type { EncryptionProvider } from './secret-vault.js';

export const electronEncryptionProvider: EncryptionProvider = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (value) => safeStorage.encryptString(value),
  decryptString: (value) => safeStorage.decryptString(value),
};
