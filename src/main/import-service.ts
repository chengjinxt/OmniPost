import type {
  ImportCandidate,
  ImportPreview,
  SourceImporter,
} from '../domain/index.js';
import type { ContentDocument } from './infrastructure/content-repository.js';

export type ImporterChoice = 'markdown' | 'tgexporter' | 'knowcraft';

export interface ImportCandidateDto {
  id: string;
  importer: string;
  kind: 'ARTICLE' | 'IMAGE_POST' | 'VIDEO';
  title: string;
  relativePath: string;
  sourceHash: string;
}

export interface ImportDiscoveryDto {
  cancelled: boolean;
  candidates: ImportCandidateDto[];
}

export interface ImportPreviewDto {
  candidateId: string;
  title: string;
  bodyMarkdown: string;
  media: Array<{
    originalName: string;
    kind: 'IMAGE_POST' | 'VIDEO';
    order: number;
  }>;
  warnings: string[];
}

export interface ContentLookup {
  get(itemId: string): ContentDocument | undefined;
}

type DirectoryChooser = (kind: ImporterChoice) => Promise<string | null>;

interface StoredCandidate {
  importer: SourceImporter;
  candidate: ImportCandidate;
}

export class ImportService {
  private readonly candidates = new Map<string, StoredCandidate>();

  public constructor(
    private readonly importers: Readonly<Partial<Record<ImporterChoice, SourceImporter>>>,
    private readonly chooseDirectory: DirectoryChooser,
    private readonly content: ContentLookup,
  ) {}

  async discover(kind: ImporterChoice): Promise<ImportDiscoveryDto> {
    const root = await this.chooseDirectory(kind);
    if (root === null) return { cancelled: true, candidates: [] };

    const importer = this.importers[kind];
    if (importer === undefined) throw new Error(`导入器尚未配置：${kind}`);
    const candidates = await importer.discover(root);
    this.candidates.clear();
    for (const candidate of candidates) {
      this.candidates.set(candidate.id, { importer, candidate });
    }
    return {
      cancelled: false,
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        importer: candidate.importer,
        kind: candidate.kind,
        title: candidate.titleHint,
        relativePath: candidate.relativePath,
        sourceHash: candidate.sourceHash,
      })),
    };
  }

  async preview(candidateId: string): Promise<ImportPreviewDto> {
    const stored = this.requireCandidate(candidateId);
    return this.toPreviewDto(await stored.importer.preview(stored.candidate));
  }

  async ingest(candidateId: string): Promise<ContentDocument> {
    const stored = this.requireCandidate(candidateId);
    const revision = await stored.importer.ingest(stored.candidate);
    const document = this.content.get(revision.contentItemId);
    if (document === undefined) {
      throw new Error(`导入完成但未找到内容项：${revision.contentItemId}`);
    }
    return document;
  }

  private requireCandidate(candidateId: string): StoredCandidate {
    const stored = this.candidates.get(candidateId);
    if (stored === undefined) throw new Error(`未知的导入候选项：${candidateId}`);
    return stored;
  }

  private toPreviewDto(preview: ImportPreview): ImportPreviewDto {
    return {
      candidateId: preview.candidate.id,
      title: preview.title,
      bodyMarkdown: preview.bodyMarkdown,
      media: preview.media.map((media) => ({
        originalName: media.originalName,
        kind: media.kind,
        order: media.order,
      })),
      warnings: [...preview.warnings],
    };
  }
}
