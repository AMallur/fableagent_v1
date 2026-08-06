import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { databaseConnectionString } from '../src/db/connection.ts';

const NAMES = ['DATABASE_URL', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'NODE_ENV'];
const original = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of NAMES) {
    if (original[name] == null) delete process.env[name];
    else process.env[name] = original[name];
  }
});

describe('database connection configuration', () => {
  it('prefers an explicitly supplied database URL', () => {
    process.env.DATABASE_URL = 'postgres://explicit/db';
    process.env.DB_HOST = 'ignored';
    assert.equal(databaseConnectionString(), 'postgres://explicit/db');
  });

  it('assembles and URL-encodes discrete ECS/RDS fields', () => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = 'production';
    process.env.DB_HOST = 'private-db.example';
    process.env.DB_PORT = '5432';
    process.env.DB_NAME = 'fable agent';
    process.env.DB_USER = 'fable_runtime';
    process.env.DB_PASSWORD = 'a:p@ss/word';
    assert.equal(databaseConnectionString(),
      'postgres://fable_runtime:a%3Ap%40ss%2Fword@private-db.example:5432/fable%20agent');
  });

  it('fails at startup when production configuration is incomplete', () => {
    delete process.env.DATABASE_URL;
    delete process.env.DB_PASSWORD;
    process.env.DB_HOST = 'private-db.example';
    process.env.DB_USER = 'fable_runtime';
    process.env.DB_NAME = 'fableagent';
    process.env.NODE_ENV = 'production';
    assert.throws(() => databaseConnectionString(), /DATABASE_URL is required in production/);
  });
});
