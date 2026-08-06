// ============================================================================
// Document storage abstraction. DOCUMENT.storage_path holds a path relative
// to the store root, so the backing store can move from local filesystem to
// object storage (S3/GCS) without touching database rows.
// ============================================================================

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function safeStoragePath(value: string): string {
  if (!value || value.includes('\0') || path.isAbsolute(value)) {
    throw new Error('invalid document storage path');
  }
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error('document storage path escapes store root');
  }
  return normalized;
}

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
    relativePath = safeStoragePath(relativePath);
    const abs = path.join(this.root, relativePath);
    await mkdir(path.dirname(abs), { recursive: true });
    const temp = `${abs}.tmp-${randomUUID()}`;
    await writeFile(temp, content, { mode: 0o640 });
    await rename(temp, abs);
    return relativePath;
  }

  async get(storagePath: string): Promise<string> {
    return readFile(path.join(this.root, safeStoragePath(storagePath)), 'utf8');
  }

  async getRaw(storagePath: string): Promise<Buffer> {
    return readFile(path.join(this.root, safeStoragePath(storagePath)));
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
    relativePath = safeStoragePath(relativePath);
    await this.bucket.file(relativePath).save(Buffer.from(content), { resumable: false });
    return relativePath;
  }

  async get(storagePath: string): Promise<string> {
    return (await this.getRaw(storagePath)).toString('utf8');
  }

  async getRaw(storagePath: string): Promise<Buffer> {
    storagePath = safeStoragePath(storagePath);
    const [buf] = await this.bucket.file(storagePath).download();
    return buf;
  }
}

interface S3CommandClient {
  send(command: unknown): Promise<any>;
}

export class S3DocumentStore implements DocumentStore {
  private readonly client: S3CommandClient;
  private readonly bucket: string;
  private readonly kmsKeyId?: string;

  constructor(
    client: S3CommandClient, bucket: string, kmsKeyId?: string,
  ) {
    this.client = client;
    this.bucket = bucket;
    this.kmsKeyId = kmsKeyId;
  }

  static async create(
    bucket: string, options: { region?: string; kmsKeyId?: string } = {},
  ): Promise<S3DocumentStore> {
    if (!bucket.trim()) throw new Error('AWS_DOCUMENT_BUCKET cannot be empty');
    const { S3Client } = await import('@aws-sdk/client-s3');
    // The default AWS credential chain uses an ECS task role, EC2 instance
    // profile, or local AWS profile. Static access keys are deliberately not
    // accepted by this API or stored by FableAgent.
    const client = new S3Client({ region: options.region ?? process.env.AWS_REGION });
    return new S3DocumentStore(client, bucket, options.kmsKeyId);
  }

  async put(relativePath: string, content: string | Uint8Array): Promise<string> {
    relativePath = safeStoragePath(relativePath);
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: relativePath,
      Body: Buffer.from(content),
      ...(this.kmsKeyId ? {
        ServerSideEncryption: 'aws:kms' as const,
        SSEKMSKeyId: this.kmsKeyId,
      } : {}),
    }));
    return relativePath;
  }

  async get(storagePath: string): Promise<string> {
    return (await this.getRaw(storagePath)).toString('utf8');
  }

  async getRaw(storagePath: string): Promise<Buffer> {
    storagePath = safeStoragePath(storagePath);
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: storagePath,
    }));
    if (!response.Body) throw new Error(`empty S3 object: ${storagePath}`);
    return Buffer.from(await response.Body.transformToByteArray());
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
  const gcsBucket = process.env.GCS_DOCUMENT_BUCKET;
  const s3Bucket = process.env.AWS_DOCUMENT_BUCKET;
  if (gcsBucket && s3Bucket) {
    throw new Error('configure exactly one document store: GCS_DOCUMENT_BUCKET or AWS_DOCUMENT_BUCKET');
  }
  if (s3Bucket) {
    return S3DocumentStore.create(s3Bucket, {
      region: process.env.AWS_REGION,
      kmsKeyId: process.env.AWS_DOCUMENT_KMS_KEY_ID,
    });
  }
  if (!gcsBucket) {
    if (process.env.NODE_ENV === 'production') {
      console.warn(
        'No object-storage bucket is set — appeal packets and letters will be '
        + 'written to local disk. Fine for a single instance with a persistent '
        + 'volume; does not survive losing that volume and cannot be shared '
        + 'across more than one app instance. Set GCS_DOCUMENT_BUCKET or '
        + 'AWS_DOCUMENT_BUCKET for a durable shared store.',
      );
    }
    return new FileSystemDocumentStore();
  }
  return GcsDocumentStore.create(gcsBucket);
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
