import type { Knex } from 'knex';
import { config } from 'dotenv';

config({ path: '../.env' });

const baseConfig: Knex.Config = {
  client: 'pg',
  connection: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'betclaude',
    user: process.env.DB_USER || 'betclaude',
    password: process.env.DB_PASSWORD || 'betclaude_dev',
  },
  pool: {
    min: 2,
    max: 10,
  },
  migrations: {
    tableName: 'knex_migrations',
    directory: './migrations',
    extension: 'ts',
  },
  seeds: {
    directory: './seeds',
    extension: 'ts',
  },
};

const knexConfig: Record<string, Knex.Config> = {
  development: baseConfig,
  production: {
    ...baseConfig,
    pool: { min: 5, max: 20 },
    connection: {
      host: process.env.DB_HOST!,
      port: parseInt(process.env.DB_PORT!, 10),
      database: process.env.DB_NAME!,
      user: process.env.DB_USER!,
      password: process.env.DB_PASSWORD!,
      ssl: { rejectUnauthorized: false },
    },
  },
};

export default knexConfig;
