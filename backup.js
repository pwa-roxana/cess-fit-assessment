const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
const MAX_BACKUPS = 30; // keep the last 30 snapshots (default: ~30 days at one/day)

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function runBackup() {
  ensureBackupDir();
  if (!fs.existsSync(DB_PATH)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUP_DIR, `data-${stamp}.sqlite`);
  fs.copyFileSync(DB_PATH, dest);
  pruneOldBackups();
  return dest;
}

function pruneOldBackups() {
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('data-') && f.endsWith('.sqlite'))
    .sort(); // ISO-style timestamps in the filename sort chronologically
  while (files.length > MAX_BACKUPS) {
    const oldest = files.shift();
    fs.unlinkSync(path.join(BACKUP_DIR, oldest));
  }
}

function listBackups() {
  ensureBackupDir();
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('data-') && f.endsWith('.sqlite'))
    .sort()
    .reverse()
    .map((f) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { filename: f, sizeBytes: stat.size, created: stat.mtime.toISOString() };
    });
}

// Only ever resolves filenames matching our own naming pattern, so this can't
// be used to read arbitrary files off disk.
function backupFilePath(filename) {
  if (!/^data-[0-9T-]+\.sqlite$/.test(filename)) return null;
  const full = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(full)) return null;
  return full;
}

module.exports = { runBackup, listBackups, backupFilePath, DB_PATH, BACKUP_DIR };
