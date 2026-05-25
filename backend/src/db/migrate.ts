import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations(): Promise<void> {
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = ['001-weather-tables.sql'];

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    console.log(`[DB] Running migration: ${file}`);
    try {
      const host = process.env.DB_HOST || 'localhost';
      const port = process.env.DB_PORT || '5432';
      const user = process.env.DB_USER || 'postgres';
      const database = process.env.DB_NAME || 'pm_weather';
      const password = process.env.DB_PASSWORD || 'postgres';

      const cmd = `PGPASSWORD="${password}" psql -h ${host} -p ${port} -U ${user} -d ${database} -f ${filePath}`;
      execSync(cmd, { stdio: 'inherit' });
      console.log(`[DB] Migration completed: ${file}`);
    } catch (error) {
      console.error(`[DB] Migration failed: ${file}`, error);
      throw error;
    }
  }
}
