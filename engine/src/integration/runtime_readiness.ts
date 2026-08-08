// ============================================================================
// Runtime integration preflight.
//
// This is intentionally side-effect free: it inspects configuration only and
// never contacts AWS, SMTP, Optum, SFTP, or a database. The live deployment can
// therefore show exactly which external values/resources are still missing
// before enabling a production capability.
// ============================================================================

export type ReadinessSeverity = 'blocker' | 'warning' | 'info';

export interface RuntimeReadinessItem {
  key: string;
  severity: ReadinessSeverity;
  ready: boolean;
  detail: string;
}

export interface RuntimeReadinessReport {
  production: boolean;
  readyForApplicationStart: boolean;
  readyForPhiStorage: boolean;
  readyForEmailDelivery: boolean;
  readyForOptumSubmission: boolean;
  items: RuntimeReadinessItem[];
}

type Env = Record<string, string | undefined>;

const hasSecret = (env: Env, name: string): boolean => Boolean(env[name] || env[`${name}_FILE`]);

export function inspectRuntimeReadiness(env: Env = process.env): RuntimeReadinessReport {
  const production = env.NODE_ENV === 'production';
  const items: RuntimeReadinessItem[] = [];
  const add = (key: string, severity: ReadinessSeverity, ready: boolean, detail: string): void => {
    items.push({ key, severity, ready, detail });
  };

  const databaseConfigured = Boolean(
    env.DATABASE_URL || (env.DB_HOST && env.DB_NAME && env.DB_USER && hasSecret(env, 'DB_PASSWORD')),
  );
  add(
    'database', 'blocker', databaseConfigured,
    databaseConfigured ? 'database connection configuration is present' : 'configure DATABASE_URL or DB_HOST/DB_NAME/DB_USER/DB_PASSWORD',
  );

  const sessionSecret = hasSecret(env, 'SESSION_SECRET');
  const encryptionKey = hasSecret(env, 'DATA_ENCRYPTION_KEY');
  add('session_secret', 'blocker', !production || sessionSecret,
    sessionSecret ? 'session signing secret is configured' : 'SESSION_SECRET is required in production');
  add('data_encryption_key', 'blocker', !production || encryptionKey,
    encryptionKey ? 'application encryption key is configured' : 'DATA_ENCRYPTION_KEY is required in production');

  const s3Configured = Boolean(env.AWS_DOCUMENT_BUCKET);
  const gcsConfigured = Boolean(env.GCS_DOCUMENT_BUCKET);
  const exactlyOneObjectStore = Number(s3Configured) + Number(gcsConfigured) === 1;
  add(
    'durable_document_store', 'blocker', !production || exactlyOneObjectStore,
    exactlyOneObjectStore
      ? `${s3Configured ? 'S3' : 'GCS'} document storage is selected`
      : production
        ? 'configure exactly one durable document store (AWS_DOCUMENT_BUCKET or GCS_DOCUMENT_BUCKET)'
        : 'local filesystem document storage is acceptable only for development',
  );

  const s3Kms = !s3Configured || Boolean(env.AWS_DOCUMENT_KMS_KEY_ID);
  add(
    's3_kms', 'blocker', !production || s3Kms,
    s3Kms ? 'S3 KMS key configuration is present or S3 is not selected' : 'AWS_DOCUMENT_KMS_KEY_ID is required for PHI-capable S3 storage',
  );

  const awsRegion = !s3Configured || Boolean(env.AWS_REGION);
  add('aws_region', 'warning', awsRegion,
    awsRegion ? 'AWS region is configured or AWS storage is not selected' : 'set AWS_REGION explicitly for deterministic AWS SDK behavior');

  const smtpConfigured = Boolean(env.SMTP_HOST && env.SMTP_FROM);
  add(
    'smtp', 'warning', smtpConfigured,
    smtpConfigured ? 'SMTP transport has host/from configuration; BAA/provider validation is still an external gate' : 'SMTP is disabled; notifications remain in-app/logged until configured',
  );

  const optumCredentials = Boolean(env.OPTUM_CLIENT_ID && env.OPTUM_CLIENT_SECRET);
  const optumLiveFlag = env.OPTUM_ALLOW_LIVE_SUBMISSION === '1';
  add(
    'optum_credentials', 'warning', optumCredentials,
    optumCredentials ? 'Optum credentials are configured' : 'Optum/Change Healthcare remains safely not_configured without credentials',
  );
  add(
    'optum_live_submission', 'warning', optumCredentials && optumLiveFlag,
    optumLiveFlag
      ? 'live Optum submission flag is enabled; partner certification must already be complete'
      : 'live Optum submission is disabled (safe default for shadow/manual pilot)',
  );

  const applicationBlockers = items.filter((i) => i.severity === 'blocker' && !i.ready);
  const readyForApplicationStart = applicationBlockers
    .filter((i) => !['durable_document_store', 's3_kms'].includes(i.key))
    .length === 0;
  const readyForPhiStorage = production
    && databaseConfigured
    && exactlyOneObjectStore
    && s3Kms
    && sessionSecret
    && encryptionKey;

  return {
    production,
    readyForApplicationStart,
    readyForPhiStorage,
    readyForEmailDelivery: readyForPhiStorage && smtpConfigured,
    readyForOptumSubmission: readyForPhiStorage && optumCredentials && optumLiveFlag,
    items,
  };
}
