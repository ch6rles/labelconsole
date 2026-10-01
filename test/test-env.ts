/** Isolated database, Redis DB and queue prefix for tests. */
export const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://labelconsole_app:app_password@127.0.0.1:5432/labelconsole_test',
  DATABASE_SYSTEM_URL: 'postgres://labelconsole_owner:owner_password@127.0.0.1:5432/labelconsole_test',
  REDIS_URL: 'redis://127.0.0.1:6379/15',
  LC_QUEUE_PREFIX: 'lctest',
  APP_URL: 'http://localhost:3000',
  VAULT_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  VAULT_MASTER_KEY_ID: 'test-v1',
  SIGNING_SECRET: 'test-signing-secret-test-signing-secret-0123456789',
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_DIR: '.storage-test',
  LC_ALLOW_DECRYPT: '1',
  LOG_LEVEL: 'silent',
  ANTHROPIC_API_KEY: '',
};
