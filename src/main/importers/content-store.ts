import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createHash } from 'node:crypto';

import { PathSafetyError, resolveSafeExistingPath } from './safety.js';

export function sha256Bytes(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function sha256File(path: string): Promise<string> {
  return sha256Bytes(await readFile(path));
}

export function sourceFingerprint(
  importer: string,
  relativePath: string,
  documentHash: string,
  mediaHashes: ReadonlyArray<readonly [relativePath: string, sha256: string | null]> = [],
): string {
  return sha256Bytes(
    JSON.stringify({
      importer,
      relativePath: relativePath.replaceAll('\\', '/'),
      documentHash,
      mediaHashes,
    }),
  );
}

export class ContentAddressedMediaStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(sourceRoot: string, sourcePath: string): Promise<{ sha256: string; storedPath: string }> {
    const safeSource = await resolveSafeExistingPath(sourceRoot, sourcePath, 'file');
    const hash = await sha256File(safeSource);
    await this.ensureSafeDirectory(this.root);
    const algorithmDirectory = join(this.root, 'sha256');
    const prefixDirectory = join(algorithmDirectory, hash.slice(0, 2));
    await this.ensureSafeDirectory(algorithmDirectory);
    await this.ensureSafeDirectory(prefixDirectory);
    const destination = join(prefixDirectory, hash);

    try {
      await copyFile(safeSource, destination, constants.COPYFILE_EXCL);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      const info = await lstat(destination);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new PathSafetyError(`Content-addressed destination is not a regular file: ${destination}`);
      }
      if ((await sha256File(destination)) !== hash) {
        throw new Error(`Content-addressed media is corrupt: ${destination}`, { cause: error });
      }
    }
    return { sha256: hash, storedPath: destination };
  }

  private async ensureSafeDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new PathSafetyError(`Media store path must be a real directory: ${path}`);
    }
    await realpath(path);
  }
}
