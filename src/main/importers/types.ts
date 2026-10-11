export type ImporterKind = 'markdown' | 'tgexporter' | 'knowcraft';
export type ImportCandidateKind = 'document' | 'media-only';
export type ImportedMediaKind = 'image' | 'video' | 'attachment';

export interface ImportCandidateContext {
  bodyRelativePath: string | null;
  topicRelativePath: string | null;
  promptsRelativePath: string | null;
  mediaRelativePaths: string[];
}

export interface ImportCandidate {
  id: string;
  importer: ImporterKind;
  kind: ImportCandidateKind;
  sourceRoot: string;
  sourcePath: string;
  relativePath: string;
  titleHint: string;
  sourceHash: string;
  documentHash: string;
  context: ImportCandidateContext;
}

export interface ImportMediaPreview {
  kind: ImportedMediaKind;
  order: number;
  sourcePath: string;
  originalName: string;
}

export interface ImportPreview {
  candidate: ImportCandidate;
  kind: ImportCandidateKind;
  title: string;
  bodyMarkdown: string;
  frontmatter: Record<string, unknown>;
  media: ImportMediaPreview[];
  metadata: Record<string, unknown>;
  warnings: string[];
}

export interface ImportedMedia extends ImportMediaPreview {
  sha256: string;
  storedPath: string;
}

export interface ContentRevision {
  sourceHash: string;
  sourcePath: string;
  importer: ImporterKind;
  kind: ImportCandidateKind;
  title: string;
  bodyMarkdown: string;
  metadata: Record<string, unknown>;
  media: ImportedMedia[];
  warnings: string[];
}

export interface SourceImporter {
  discover(root: string): Promise<ImportCandidate[]>;
  preview(candidate: ImportCandidate): Promise<ImportPreview>;
  ingest(candidate: ImportCandidate): Promise<ContentRevision>;
}

export interface ImporterOptions {
  mediaStoreRoot: string;
}
