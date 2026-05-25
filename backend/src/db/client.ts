import pg from 'pg';

interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

function getDbConfig(): DbConfig {
  return {
    host: process.env.DB_HOST || 'postgres',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'pm_weather',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  };
}

let pool: pg.Pool | null = null;

export function initDbPool(): pg.Pool {
  if (pool) return pool;

  const config = getDbConfig();
  console.log(`[DB] Initializing pool: ${config.user}@${config.host}:${config.port}/${config.database}`);

  pool = new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
  });

  pool.on('error', (err) => {
    console.error('[DB] Unexpected pool error:', err);
  });

  return pool;
}

export function getDb(): pg.Pool {
  if (!pool) {
    throw new Error('Database pool not initialized. Call initDbPool() first.');
  }
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
