import { existsSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';

const temporaryRootPrefix = 'omnipost-install-smoke-';

export function buildNsisInstallArguments(installDirectory: string): string[] {
  return ['/S', `/D=${resolve(installDirectory)}`];
}

export function assertSafeTemporaryInstallLayout(
  temporaryBaseDirectory: string,
  temporaryRoot: string,
  installDirectory: string,
): void {
  const resolvedBase = canonicalPath(temporaryBaseDirectory);
  const resolvedRoot = canonicalPath(temporaryRoot);
  const resolvedInstallDirectory = canonicalPath(installDirectory);

  if (
    !isStrictDescendant(resolvedBase, resolvedRoot)
    || !basename(resolvedRoot).startsWith(temporaryRootPrefix)
  ) {
    throw new Error(
      `Unsafe temporary root for the package smoke test: ${resolvedRoot}`,
    );
  }

  if (!isStrictDescendant(resolvedRoot, resolvedInstallDirectory)) {
    throw new Error(
      `Unsafe install directory for the package smoke test: ${resolvedInstallDirectory}`,
    );
  }
}

function canonicalPath(path: string): string {
  return existsSync(path) ? realpathSync.native(path) : resolve(path);
}

function isStrictDescendant(parent: string, child: string): boolean {
  const childRelativeToParent = relative(parent, child);
  return childRelativeToParent.length > 0
    && childRelativeToParent !== '..'
    && !childRelativeToParent.startsWith(`..\\`)
    && !childRelativeToParent.startsWith('../')
    && !isAbsolute(childRelativeToParent);
}
