import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export class PathSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathSafetyError';
  }
}

function isWithin(root: string, target: string): boolean {
  const difference = relative(root, target);
  return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference));
}

async function assertNotLink(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    throw new PathSafetyError(`Symbolic links and directory junctions are not allowed: ${path}`);
  }
}

async function assertNoLinkedAncestor(path: string): Promise<void> {
  const absolute = resolve(path);
  const filesystemRoot = parse(absolute).root;
  const difference = relative(filesystemRoot, absolute);
  let cursor = filesystemRoot;
  for (const segment of difference.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    await assertNotLink(cursor);
  }
}

export async function resolveSafeRoot(root: string): Promise<string> {
  const absoluteRoot = resolve(root);
  await assertNoLinkedAncestor(absoluteRoot);
  const info = await lstat(absoluteRoot);
  if (!info.isDirectory()) {
    throw new PathSafetyError(`Import root is not a directory: ${absoluteRoot}`);
  }
  return realpath(absoluteRoot);
}

export async function resolveSafeExistingPath(
  root: string,
  target: string,
  expected: 'file' | 'directory',
): Promise<string> {
  const safeRoot = await resolveSafeRoot(root);
  const absoluteTarget = resolve(target);
  if (!isWithin(safeRoot, absoluteTarget)) {
    throw new PathSafetyError(`Path escapes the import root: ${target}`);
  }

  const difference = relative(safeRoot, absoluteTarget);
  let cursor = safeRoot;
  if (difference) {
    for (const segment of difference.split(sep)) {
      cursor = join(cursor, segment);
      await assertNotLink(cursor);
    }
  }

  const resolvedTarget = await realpath(absoluteTarget);
  if (!isWithin(safeRoot, resolvedTarget)) {
    throw new PathSafetyError(`Resolved path escapes the import root: ${target}`);
  }
  const info = await lstat(resolvedTarget);
  if (expected === 'file' && !info.isFile()) {
    throw new PathSafetyError(`Expected a regular file: ${target}`);
  }
  if (expected === 'directory' && !info.isDirectory()) {
    throw new PathSafetyError(`Expected a directory: ${target}`);
  }
  return resolvedTarget;
}

interface WalkOptions {
  extensions: ReadonlySet<string>;
  excludedNames?: ReadonlySet<string>;
}

export async function walkSafeFiles(root: string, options: WalkOptions): Promise<string[]> {
  const safeRoot = await resolveSafeRoot(root);
  const files: string[] = [];
  const excluded = new Set(
    [...(options.excludedNames ?? [])].map((name) => name.toLocaleLowerCase('en-US')),
  );

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
    for (const entry of entries) {
      if (excluded.has(entry.name.toLocaleLowerCase('en-US'))) continue;
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        throw new PathSafetyError(`Symbolic links and directory junctions are not allowed: ${path}`);
      }
      if (info.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!info.isFile()) continue;
      const extension = entry.name.slice(entry.name.lastIndexOf('.')).toLocaleLowerCase('en-US');
      if (options.extensions.has(extension)) files.push(path);
    }
  }

  await visit(safeRoot);
  return files;
}

export function assertRelativeTarget(target: string): void {
  if (isAbsolute(target) || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(target)) {
    throw new PathSafetyError(`Only relative local media paths can be imported: ${target}`);
  }
}
