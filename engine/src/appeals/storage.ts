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

export class GcsDocumentStore implements DocumentStore {
  private readonly bucket: import('@google-cloud/storage').Bucket;

  /** private: use GcsDocumentStore.create() — @google-cloud/storage is loaded
   *  lazily via dynamic import so environments that never construct one
   *  (tests, the local-filesystem-only default) never pay for loading it */
  private constructor(bucket: import('@google-cloud/storage').Bucket) {
    this.bucket = bucket;
  }

  static async create(bucketName: string): Promise<GcsDocumentStore> {
    const { Storage } = await import('@google-cloud/storage');
    // Application Default Credentials: the VM's/container's attached service
    // account in production, or `gcloud auth application-default login` /
    // GOOGLE_APPLICATION_CREDENTIALS locally — no key material in this repo.
    return new GcsDocumentStore(new Storage().bucket(bucketName));
  }

  async put(relativePath: string, content: string | Uint8Array): Promise<string> {
    await this.bucket.file(relativePath).save(Buffer.from(content), { resumable: false });
    return relativePath;
  }

  async get(storagePath: string): Promise<string> {
    return (await this.getRaw(storagePath)).toString('utf8');
  }

  async getRaw(storagePath: string): Promise<Buffer> {
    const [buf] = await this.bucket.file(storagePath).download();
    return buf;
  }
}

/**
 * Picks the document store from environment: GCS_DOCUMENT_BUCKET set ->
 * object storage (durable, shared across instances); unset -> local
 * filesystem, which only survives as long as the volume it's mounted on and
 * cannot be shared across more than one app instance. Fine for a single-VM
 * deployment with a persistent volume (see docker-compose.yml); not fine
 * once you're running more than one app instance or want documents to
 * outlive the VM itself.
 */
export async function resolveDocumentStore(): Promise<DocumentStore> {
  const bucket = process.env.GCS_DOCUMENT_BUCKET;
  if (!bucket) {
    if (process.env.NODE_ENV === 'production') {
      console.warn(
        'GCS_DOCUMENT_BUCKET is not set — appeal packets and letters will be '
        + 'written to local disk. Fine for a single instance with a persistent '
        + 'volume; does not survive losing that volume and cannot be shared '
        + 'across more than one app instance. Set GCS_DOCUMENT_BUCKET to move '
        + 'to Cloud Storage.',
      );
    }
    return new FileSystemDocumentStore();
  }
  return GcsDocumentStore.create(bucket);
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
