const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const DB_PATH = path.join(__dirname, 'bot_data.sqlite');

let db = null;

/**
 * Initialize database connection and create tables
 */
function init() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Create messages table
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      group_id TEXT NOT NULL,
      hashed_phone TEXT NOT NULL,
      message_body TEXT,
      is_from_admin BOOLEAN DEFAULT 0,
      is_from_bot BOOLEAN DEFAULT 0
    )
  `);

  // Create verified_users table for tracking verification status
  db.exec(`
    CREATE TABLE IF NOT EXISTS verified_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      hashed_phone TEXT NOT NULL,
      group_id TEXT NOT NULL,
      verified_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create pending_verifications table (with captcha_code for image captcha)
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      group_id TEXT NOT NULL,
      expected_answer INTEGER,
      captcha_code TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      UNIQUE(phone, group_id)
    )
  `);

  // Add captcha_code column if it doesn't exist (migration for existing DBs)
  try {
    db.exec(`ALTER TABLE pending_verifications ADD COLUMN captcha_code TEXT`);
  } catch (e) {
    // Column already exists, ignore
  }

  // Create moderation_logs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS moderation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      group_id TEXT NOT NULL,
      user_phone TEXT NOT NULL,
      hashed_phone TEXT NOT NULL,
      user_name TEXT,
      message_body TEXT,
      violation_type TEXT NOT NULL,
      action_taken TEXT NOT NULL,
      admin_response TEXT,
      category_scores TEXT,
      message_key TEXT,
      restored INTEGER DEFAULT 0
    )
  `);

  // Add new columns if they don't exist (migration for existing DBs)
  try {
    db.exec(`ALTER TABLE moderation_logs ADD COLUMN message_key TEXT`);
  } catch (e) {
    // Column already exists, ignore
  }
  try {
    db.exec(`ALTER TABLE moderation_logs ADD COLUMN restored INTEGER DEFAULT 0`);
  } catch (e) {
    // Column already exists, ignore
  }
  try {
    db.exec(`ALTER TABLE moderation_logs ADD COLUMN user_name TEXT`);
  } catch (e) {
    // Column already exists, ignore
  }

  // Create indexes for better query performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_pending_phone ON pending_verifications(phone);
    CREATE INDEX IF NOT EXISTS idx_verified_phone ON verified_users(phone);
    CREATE INDEX IF NOT EXISTS idx_moderation_group ON moderation_logs(group_id);
    CREATE INDEX IF NOT EXISTS idx_moderation_timestamp ON moderation_logs(timestamp);
  `);

  console.log('[DB] Database initialized successfully');
  return db;
}

/**
 * Hash phone number using SHA256
 * @param {string} phone - Phone number to hash
 * @returns {string} Hashed phone number
 */
function hashPhone(phone) {
  return crypto.createHash('sha256').update(phone).digest('hex');
}

/**
 * Save a message to the database
 * @param {Object} messageData - Message data
 */
function saveMessage({ groupId, phone, messageBody, isFromAdmin, isFromBot }) {
  const stmt = db.prepare(`
    INSERT INTO messages (group_id, hashed_phone, message_body, is_from_admin, is_from_bot)
    VALUES (?, ?, ?, ?, ?)
  `);

  const hashedPhone = hashPhone(phone);
  stmt.run(groupId, hashedPhone, messageBody, isFromAdmin ? 1 : 0, isFromBot ? 1 : 0);
  console.log(`[DB] Message saved from ${hashedPhone.substring(0, 8)}... in group ${groupId}`);
}

/**
 * Add a pending verification for a new member (math question)
 * @param {string} phone - User's phone number
 * @param {string} groupId - Group chat ID
 * @param {number} expectedAnswer - Expected math answer
 * @param {number} timeoutMinutes - Timeout in minutes
 */
function addPendingVerification(phone, groupId, expectedAnswer, timeoutMinutes) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO pending_verifications (phone, group_id, expected_answer, expires_at)
    VALUES (?, ?, ?, datetime('now', '+' || ? || ' minutes'))
  `);

  stmt.run(phone, groupId, expectedAnswer, timeoutMinutes);
  console.log(`[DB] Pending verification added for ${phone} in group ${groupId}`);
}

/**
 * Add a pending captcha verification for a new member
 * @param {string} phone - User's phone number
 * @param {string} groupId - Group chat ID
 * @param {string} captchaCode - Expected captcha code
 * @param {number} timeoutMinutes - Timeout in minutes
 */
function addPendingCaptcha(phone, groupId, captchaCode, timeoutMinutes) {
  if (!captchaCode) {
    console.error('[DB] Error: captchaCode is undefined');
    return;
  }

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO pending_verifications (phone, group_id, expected_answer, captcha_code, expires_at)
    VALUES (?, ?, 0, ?, datetime('now', '+' || ? || ' minutes'))
  `);

  stmt.run(phone, groupId, captchaCode.toUpperCase(), timeoutMinutes);
  console.log(`[DB] Pending captcha verification added for ${phone} in group ${groupId}`);
}

/**
 * Get pending verification for a user
 * @param {string} phone - User's phone number
 * @param {string} groupId - Group chat ID
 * @returns {Object|null} Verification data or null
 */
function getPendingVerification(phone, groupId) {
  const stmt = db.prepare(`
    SELECT * FROM pending_verifications
    WHERE phone = ? AND group_id = ? AND expires_at > datetime('now')
  `);

  return stmt.get(phone, groupId);
}

/**
 * Remove pending verification
 * @param {string} phone - User's phone number
 * @param {string} groupId - Group chat ID
 */
function removePendingVerification(phone, groupId) {
  const stmt = db.prepare(`
    DELETE FROM pending_verifications WHERE phone = ? AND group_id = ?
  `);

  stmt.run(phone, groupId);
  console.log(`[DB] Pending verification removed for ${phone}`);
}

/**
 * Mark user as verified
 * @param {string} phone - User's phone number
 * @param {string} groupId - Group chat ID
 */
function markUserVerified(phone, groupId) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO verified_users (phone, hashed_phone, group_id)
    VALUES (?, ?, ?)
  `);

  stmt.run(phone, hashPhone(phone), groupId);
  console.log(`[DB] User ${phone} marked as verified in group ${groupId}`);
}

/**
 * Check if user is verified
 * @param {string} phone - User's phone number
 * @param {string} groupId - Group chat ID
 * @returns {boolean}
 */
function isUserVerified(phone, groupId) {
  const stmt = db.prepare(`
    SELECT 1 FROM verified_users WHERE phone = ? AND group_id = ?
  `);

  return stmt.get(phone, groupId) !== undefined;
}

/**
 * Get verified users count per group
 * @returns {Array} Array of {group_id, count}
 */
function getVerifiedCountByGroup() {
  const stmt = db.prepare(`
    SELECT group_id, COUNT(*) as count FROM verified_users GROUP BY group_id
  `);

  return stmt.all();
}

/**
 * Get last N verified users
 * @param {number} limit - Number of users to retrieve
 * @returns {Array} Array of verified users
 */
function getLastVerifiedUsers(limit = 10) {
  const stmt = db.prepare(`
    SELECT phone, group_id, verified_at FROM verified_users
    ORDER BY verified_at DESC LIMIT ?
  `);

  return stmt.all(limit);
}

/**
 * Get expired pending verifications (for cleanup/kick)
 * @returns {Array} Array of expired verifications
 */
function getExpiredVerifications() {
  const stmt = db.prepare(`
    SELECT * FROM pending_verifications WHERE expires_at <= datetime('now')
  `);

  return stmt.all();
}

/**
 * Clean up expired verifications
 */
function cleanupExpiredVerifications() {
  const stmt = db.prepare(`
    DELETE FROM pending_verifications WHERE expires_at <= datetime('now')
  `);

  const result = stmt.run();
  if (result.changes > 0) {
    console.log(`[DB] Cleaned up ${result.changes} expired verifications`);
  }
  return result.changes;
}

/**
 * Log a moderation action
 * @param {Object} data - Moderation data
 * @returns {number} The ID of the inserted log
 */
function logModeration({ groupId, userPhone, userName, messageBody, violationType, actionTaken, categoryScores, messageKey }) {
  const stmt = db.prepare(`
    INSERT INTO moderation_logs (group_id, user_phone, hashed_phone, user_name, message_body, violation_type, action_taken, category_scores, message_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const hashedPhone = hashPhone(userPhone);
  const result = stmt.run(groupId, userPhone, hashedPhone, userName || null, messageBody, violationType, actionTaken, JSON.stringify(categoryScores || {}), messageKey ? JSON.stringify(messageKey) : null);
  console.log(`[DB] Moderation logged: ${violationType} -> ${actionTaken}`);
  return result.lastInsertRowid;
}

/**
 * Get a moderation log by ID
 * @param {number} logId - Log ID
 * @returns {Object|null} Moderation log or null
 */
function getModerationLogById(logId) {
  const stmt = db.prepare(`SELECT * FROM moderation_logs WHERE id = ?`);
  return stmt.get(logId);
}

/**
 * Mark a moderation log as restored
 * @param {number} logId - Log ID
 */
function markMessageRestored(logId) {
  const stmt = db.prepare(`UPDATE moderation_logs SET restored = 1 WHERE id = ?`);
  stmt.run(logId);
  console.log(`[DB] Message ${logId} marked as restored`);
}

/**
 * Update admin response for a moderation log
 * @param {number} logId - Log ID
 * @param {string} response - Admin response (ignore/ban/mute)
 */
function updateModerationResponse(logId, response) {
  const stmt = db.prepare(`
    UPDATE moderation_logs SET admin_response = ? WHERE id = ?
  `);
  stmt.run(response, logId);
}

/**
 * Get recent moderation logs
 * @param {number} limit - Number of logs to retrieve
 * @returns {Array} Array of moderation logs
 */
function getRecentModerationLogs(limit = 20) {
  const stmt = db.prepare(`
    SELECT * FROM moderation_logs ORDER BY timestamp DESC LIMIT ?
  `);
  return stmt.all(limit);
}

/**
 * Get messages from the last N days for a specific group
 * @param {string} groupId - Group ID
 * @param {number} days - Number of days to look back
 * @param {number} limit - Maximum messages to retrieve
 * @returns {Array} Array of messages
 */
function getMessagesLastDays(groupId, days = 7, limit = 500) {
  const stmt = db.prepare(`
    SELECT message_body, timestamp, hashed_phone
    FROM messages
    WHERE group_id = ?
      AND timestamp >= datetime('now', '-' || ? || ' days')
      AND message_body IS NOT NULL
      AND message_body != ''
    ORDER BY timestamp DESC
    LIMIT ?
  `);
  return stmt.all(groupId, days, limit);
}

/**
 * Get message count by day for a group (last N days)
 * @param {string} groupId - Group ID
 * @param {number} days - Number of days
 * @returns {Array} Array of {day, count}
 */
function getMessageCountByDay(groupId, days = 7) {
  const stmt = db.prepare(`
    SELECT
      strftime('%w', timestamp) as day_of_week,
      COUNT(*) as count
    FROM messages
    WHERE group_id = ?
      AND timestamp >= datetime('now', '-' || ? || ' days')
    GROUP BY day_of_week
    ORDER BY count DESC
  `);
  return stmt.all(groupId, days);
}

/**
 * Get total message count for a group (last N days)
 * @param {string} groupId - Group ID
 * @param {number} days - Number of days
 * @returns {number} Total count
 */
function getTotalMessageCount(groupId, days = 7) {
  const stmt = db.prepare(`
    SELECT COUNT(*) as count
    FROM messages
    WHERE group_id = ?
      AND timestamp >= datetime('now', '-' || ? || ' days')
  `);
  const result = stmt.get(groupId, days);
  return result ? result.count : 0;
}

/**
 * Get unique users count for a group (last N days)
 * @param {string} groupId - Group ID
 * @param {number} days - Number of days
 * @returns {number} Unique users count
 */
function getUniqueUsersCount(groupId, days = 7) {
  const stmt = db.prepare(`
    SELECT COUNT(DISTINCT hashed_phone) as count
    FROM messages
    WHERE group_id = ?
      AND timestamp >= datetime('now', '-' || ? || ' days')
  `);
  const result = stmt.get(groupId, days);
  return result ? result.count : 0;
}

/**
 * Clear all moderation logs
 * @returns {number} Number of deleted records
 */
function clearModerationLogs() {
  const stmt = db.prepare(`DELETE FROM moderation_logs`);
  const result = stmt.run();
  console.log(`[DB] Cleared ${result.changes} moderation logs`);
  return result.changes;
}

/**
 * Close database connection
 */
function close() {
  if (db) {
    db.close();
    console.log('[DB] Database connection closed');
  }
}

module.exports = {
  init,
  hashPhone,
  saveMessage,
  addPendingVerification,
  addPendingCaptcha,
  getPendingVerification,
  removePendingVerification,
  markUserVerified,
  isUserVerified,
  getVerifiedCountByGroup,
  getLastVerifiedUsers,
  getExpiredVerifications,
  cleanupExpiredVerifications,
  logModeration,
  getModerationLogById,
  markMessageRestored,
  updateModerationResponse,
  getRecentModerationLogs,
  getMessagesLastDays,
  getMessageCountByDay,
  getTotalMessageCount,
  getUniqueUsersCount,
  clearModerationLogs,
  close
};
