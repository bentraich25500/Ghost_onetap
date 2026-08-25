const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const util = require('util');

const dbPath = path.join(__dirname, 'database', 'tempVoice.db');
const whitelistDbPath = path.join(__dirname, 'database', 'whitelist.db');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening main database:', err.message);
  } else {
    console.log('Connected to SQLite DB');
    db.serialize(() => {
      db.run(`
        CREATE TABLE IF NOT EXISTS temp_channels (
          channel_id TEXT PRIMARY KEY,
          guild_id TEXT,
          owner_id TEXT,
          base_name TEXT,
          locked INTEGER DEFAULT 0
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS voice_statuses (
          channel_id TEXT PRIMARY KEY,
          status TEXT
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS guild_config (
          guild_id TEXT PRIMARY KEY,
          lobby_channel_id TEXT,
          setup_room_id TEXT
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS dontuse_users (
          guild_id TEXT,
          user_id TEXT,
          PRIMARY KEY (guild_id, user_id)
        )
      `);
    });
  }
});

const whitelistDb = new sqlite3.Database(whitelistDbPath, (err) => {
  if (err) {
    console.error('Error opening whitelist database:', err.message);
  } else {
    console.log('Whitelist DB connected');
    whitelistDb.run(`
      CREATE TABLE IF NOT EXISTS user_whitelists (
        owner_id TEXT,
        user_id TEXT,
        PRIMARY KEY (owner_id, user_id)
      )
    `);
    whitelistDb.run(`
      CREATE TABLE IF NOT EXISTS user_blacklists (
        owner_id TEXT,
        user_id TEXT,
        PRIMARY KEY (owner_id, user_id)
      )
    `);
  }
});

// Promisify all the methods we need
const dbRun = util.promisify(db.run.bind(db));
const dbGet = util.promisify(db.get.bind(db));
const dbAll = util.promisify(db.all.bind(db));

const whitelistDbRun = util.promisify(whitelistDb.run.bind(whitelistDb));
const whitelistDbGet = util.promisify(whitelistDb.get.bind(whitelistDb));
const whitelistDbAll = util.promisify(whitelistDb.all.bind(whitelistDb));

module.exports = {
  db,
  whitelistDb,
  dbRun,
  dbGet,
  dbAll,
  whitelistDbRun,
  whitelistDbGet,
  whitelistDbAll,
};
