// ============================================================================
// Document storage abstraction. DOCUMENT.storage_path holds a path relative
// to the store root, so the backing store can move from local filesystem to
// object storage (S3/GCS) without touching database rows.
// ============================================================================

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface DocumentStore {
  /** write content, return the storage_path to persist on the DOCUMENT row */
  put(relativePath: string, content: string | Uint8Array): Promise<string>;
  /** text content (generated letters/summaries) */
  get(storagePath: string): Promise<string>;
  /** raw bytes (uploaded files) */
  getRaw(storagePath: string): Promise<Buffer>;
}

export class FileSystemDocumentStore implements DocumentStore {
  readonly root: string;

  constructor(root?: string) {
    this.root = root
      ?? process.env.DOCUMENT_STORE_ROOT
      ?? path.join(process.cwd(), 'var', 'documents');
  }

  async put(relativePath: string, content: string | Uint8Array): Promise<string> {
    const abs = path.join(this.root, relativePath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
    return relativePath;
  }

  async get(storagePath: string): Promise<string> {
    return readFile(path.join(this.root, storagePath), 'utf8');
  }

  async getRaw(storagePath: string): Promise<Buffer> {
    return readFile(path.join(this.root, storagePath));
  }
}

/** In-memory store for tests. */
export class MemoryDocumentStore implements DocumentStore {
  readonly files = new Map<string, Buffer>();

  async put(relativePath: string, content: string | Uint8Array): Promise<string> {
    this.files.set(relativePath, Buffer.from(content));
    return relativePath;
  }

  async get(storagePath: string): Promise<string> {
    return (await this.getRaw(storagePath)).toString('utf8');
  }

  async getRaw(storagePath: string): Promise<Buffer> {
    const content = this.files.get(storagePath);
    if (content == null) throw new Error(`not found in store: ${storagePath}`);
    return content;
  }
}
