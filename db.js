const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dbPath =
  process.env.DB_PATH ||
  (fs.existsSync('/data') ? '/data/mafia.db' : path.join(__dirname, 'mafia.db'));
const db = new sqlite3.Database(dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      token TEXT
    )
  `);

  await run (`
    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      host_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'WAITING',
      game_state TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )  
  `);

  const cols = (await all('PRAGMA table_info(users)')).map((c) => c.name);
  if (!cols.includes('token_hash')) await run('ALTER TABLE users ADD COLUMN token_hash TEXT');
  if (!cols.includes('last_seen_at')) {
    await run('ALTER TABLE users ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0');
  }

  if (cols.includes('token')) {
    const old = await all('SELECT id, token FROM users WHERE token_hash IS NULL AND token IS NOT NULL');
    for (const u of old) {
      await run('UPDATE users SET token_hash = ?, last_seen_at = ? WHERE id = ?',
        [hashToken(u.token), Date.now(), u.id]);
    }
  }

  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_token_hash ON users(token_hash)');
  try {
    await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_name_nocase ON users(username COLLATE NOCASE)');
  } catch (e) {
    console.error('Не удалось создать индекс имён (есть дубли по регистру?):', e.message);
  }

  if (cols.includes('token')) {
    const old = await all('SELECT id, token FROM users WHERE token_hash IS NULL AND token IS NOT NULL');
    for (const u of old) {
      await run('UPDATE users SET token_hash = ?, last_seen_at = ? WHERE id = ?',
        [hashToken(u.token), Date.now(), u.id]);
    }
    await run('UPDATE users SET token = NULL WHERE token IS NOT NULL');
  }
}

module.exports = { db, run, get, all, hashToken, initDb };
