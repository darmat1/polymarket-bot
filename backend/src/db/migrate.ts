import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations(): Promise<void> {
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = ['001-weather-tables.sql'];
  const db = getDb();

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    console.log(`[DB] Running migration: ${file}`);
    try {
      const sql = readFileSync(filePath, 'utf-8');
      await db.query(sql);
      console.log(`[DB] Migration completed: ${file}`);
    } catch (error) {
      console.error(`[DB] Migration failed: ${file}`, error);
      throw error;
    }
  }
}
