const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const express = require('express');
const path = require('path');
const db = require('./db');
const verification = require('./verification');
const moderation = require('./moderation');
const { generateWeeklyDashboard } = require('./summary/summary');
const config = require('./config.json');

// Initialize database
db.init();

// ==================== EXPRESS SERVER ====================

const app = express();
const PORT = 3000;

// Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Store socket reference globally
let sock = null;
let botNumber = null;

// Cache for group name -> ID mapping
let groupNameToId = {};
let groupIdToName = {};

// API: Get bot status
app.get('/api/bot-status', (req, res) => {
  // Get monitored groups with their status (found or not found)
  const monitoredGroupsStatus = config.groupsToMonitor.map(name => ({
    name,
    id: groupNameToId[name.toLowerCase()] || null,
    found: !!groupNameToId[name.toLowerCase()]
  }));

  res.json({
    connected: sock !== null && botNumber !== null,
    botNumber: botNumber || null,
    config: {
      groupsCount: config.groupsToMonitor.length,
      verificationTimeout: config.verificationTimeoutMinutes,
      monitoredGroups: monitoredGroupsStatus
    }
  });
});

// API: Help command
app.get('/api/help', (req, res) => {
  res.json({
    success: true,
    data: {
      monitoredGroups: config.groupsToMonitor.length,
      verificationTimeout: config.verificationTimeoutMinutes,
    }
  });
});

// API: Status command - verified users by group
app.get('/api/status', async (req, res) => {
  try {
    const stats = db.getVerifiedCountByGroup();

    const result = [];
    for (const stat of stats) {
      let groupName = getGroupNameFromConfig(stat.group_id);
      if (groupName === stat.group_id) {
        try {
          if (sock) {
            const groupMetadata = await sock.groupMetadata(stat.group_id);
            groupName = groupMetadata.subject || stat.group_id;
          }
        } catch (e) {
          // Use ID if name can't be fetched
        }
      }
      result.push({
        groupId: stat.group_id,
        groupName: groupName,
        count: stat.count
      });
    }

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[API] Error in /api/status:', error.message);
    res.json({ success: false, error: error.message });
  }
});

// API: Verified users command - last 10 verified
app.get('/api/verified', async (req, res) => {
  try {
    const users = db.getLastVerifiedUsers(10);

    const result = [];
    for (const user of users) {
      let groupName = getGroupNameFromConfig(user.group_id);
      if (groupName === user.group_id) {
        try {
          if (sock) {
            const groupMetadata = await sock.groupMetadata(user.group_id);
            groupName = groupMetadata.subject || user.group_id;
          }
        } catch (e) {
          groupName = 'Unknown Group';
        }
      }
      result.push({
        maskedPhone: maskPhone(user.phone),
        groupName: groupName,
        verifiedAt: new Date(user.verified_at).toLocaleString()
      });
    }

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[API] Error in /api/verified:', error.message);
    res.json({ success: false, error: error.message });
  }
});

// API: List all groups
app.get('/api/groups', async (req, res) => {
  try {
    if (!sock) {
      return res.json({ success: false, error: 'Bot not connected' });
    }

    const groups = await sock.groupFetchAllParticipating();
    const groupList = Object.values(groups).map(g => ({
      id: g.id,
      name: g.subject,
      participants: g.participants.length
    }));

    res.json({ success: true, data: groupList });
  } catch (error) {
    console.error('[API] Error in /api/groups:', error.message);
    res.json({ success: false, error: error.message });
  }
});

// API: Generate weekly summary dashboard
app.get('/api/weeklysummary', async (req, res) => {
  try {
    console.log('[API] Generating weekly summary...');
    const monitoredGroups = getMonitoredGroups();
    const result = await generateWeeklyDashboard(sock, monitoredGroups);
    console.log(`[API] Dashboard updated -> ${result.dashboardUrl}`);
    res.json({
      success: true,
      message: 'Weekly summary generated',
      dashboardUrl: result.dashboardUrl,
      summaries: result.summaries,
      groups: result.summaries.length
    });
  } catch (error) {
    console.error('[API] Error generating weekly summary:', error.message);
    res.json({ success: false, error: error.message });
  }
});

// Route: Serve weekly dashboard HTML
app.get('/dashboard', (req, res) => {
  const dashboardPath = path.join(__dirname, 'public', 'dashboard.html');
  res.sendFile(dashboardPath, (err) => {
    if (err) {
      res.status(404).send(`
        <html>
          <head><title>Dashboard Not Found</title></head>
          <body style="font-family: sans-serif; padding: 40px; text-align: center;">
            <h1>Dashboard Not Generated Yet</h1>
            <p>Run the weekly summary command first:</p>
            <p><code>!weeklysummary</code> in a WhatsApp group</p>
            <p>Or visit: <a href="/api/weeklysummary">/api/weeklysummary</a></p>
          </body>
        </html>
      `);
    }
  });
});

// API: Get moderation logs with group names
app.get('/api/moderation-logs', async (req, res) => {
  try {
    const logs = db.getRecentModerationLogs(50);

    // Add group names to logs (from config or WhatsApp)
    const logsWithNames = await Promise.all(logs.map(async (log) => {
      let groupName = getGroupNameFromConfig(log.group_id);
      if (groupName === log.group_id) {
        try {
          if (sock) {
            const metadata = await sock.groupMetadata(log.group_id);
            groupName = metadata.subject || log.group_id;
          }
        } catch (e) {
          // Keep group_id if can't fetch name
        }
      }
      return { ...log, group_name: groupName };
    }));

    res.json({ success: true, data: logsWithNames });
  } catch (error) {
    console.error('[API] Error fetching moderation logs:', error.message);
    res.json({ success: false, error: error.message });
  }
});

// API: Clear all moderation logs
app.post('/api/clear-moderation-logs', (req, res) => {
  try {
    const deleted = db.clearModerationLogs();
    console.log(`[API] Cleared ${deleted} moderation logs`);
    res.json({ success: true, deleted });
  } catch (error) {
    console.error('[API] Error clearing moderation logs:', error.message);
    res.json({ success: false, error: error.message });
  }
});

// API: Restore a deleted message (resend it to the group)
app.post('/api/restore-message/:id', async (req, res) => {
  try {
    const logId = parseInt(req.params.id);
    const log = db.getModerationLogById(logId);

    if (!log) {
      return res.json({ success: false, error: 'Message not found' });
    }

    if (log.restored) {
      return res.json({ success: false, error: 'Message already restored' });
    }

    if (!sock) {
      return res.json({ success: false, error: 'Bot not connected' });
    }

    // Get group name for the message
    let groupName = getGroupNameFromConfig(log.group_id);
    if (groupName === log.group_id) {
      try {
        const metadata = await sock.groupMetadata(log.group_id);
        groupName = metadata.subject || log.group_id;
      } catch (e) {}
    }

    // Mask the phone for privacy
    const maskedPhone = log.user_phone.length > 6
      ? log.user_phone.substring(0, 4) + '****' + log.user_phone.substring(log.user_phone.length - 2)
      : '****';

    // Display name if available
    const displayName = log.user_name || maskedPhone;

    // Resend the message with a note that it was restored
    const restoredMessage = `📩 *Restored Message*\n\n*From:* ${displayName}\n*Original message:*\n\n${log.message_body}`;

    await sock.sendMessage(log.group_id, { text: restoredMessage });

    // Mark as restored in database
    db.markMessageRestored(logId);

    console.log(`[API] Message ${logId} restored to group ${groupName}`);
    res.json({ success: true, message: 'Message restored successfully' });
  } catch (error) {
    console.error('[API] Error restoring message:', error.message);
    res.json({ success: false, error: error.message });
  }
});

// Start Express server
app.listen(PORT, () => {
  console.log(`[WEB] Dashboard running at http://localhost:${PORT}`);
  console.log(`[WEB] Weekly dashboard at http://localhost:${PORT}/dashboard`);
});

// ==================== HELPER FUNCTIONS ====================

/**
 * Fetch all groups and build name -> ID mapping
 * @returns {Promise<void>}
 */
async function buildGroupMapping() {
  if (!sock) return;

  try {
    const groups = await sock.groupFetchAllParticipating();
    groupNameToId = {};
    groupIdToName = {};

    for (const [id, group] of Object.entries(groups)) {
      const name = group.subject;
      groupNameToId[name.toLowerCase()] = id;
      groupIdToName[id] = name;
    }

    console.log(`[GROUPS] Loaded ${Object.keys(groupNameToId).length} groups`);

    // Get the first admin from config
    const primaryAdmin = config.admins && config.admins.length > 0 ? config.admins[0] : null;
    const primaryAdminJid = primaryAdmin ? `${primaryAdmin}@s.whatsapp.net` : null;

    // Log monitored groups status and validate admin
    for (const groupName of config.groupsToMonitor) {
      const groupId = groupNameToId[groupName.toLowerCase()];
      if (groupId) {
        console.log(`[GROUPS] Monitoring: "${groupName}" -> ${groupId}`);

        // Validate that primary admin is a group admin
        if (primaryAdminJid) {
          try {
            const groupMetadata = await sock.groupMetadata(groupId);
            const adminParticipant = groupMetadata.participants.find(p =>
              p.id === primaryAdminJid || jidToPhone(p.id) === primaryAdmin
            );

            if (adminParticipant && (adminParticipant.admin === 'admin' || adminParticipant.admin === 'superadmin')) {
              console.log(`[GROUPS] ✓ Primary admin (${primaryAdmin}) is admin of "${groupName}"`);
            } else if (adminParticipant) {
              console.log(`[GROUPS] ⚠ WARNING: Primary admin (${primaryAdmin}) is NOT an admin of "${groupName}"`);
            } else {
              console.log(`[GROUPS] ⚠ WARNING: Primary admin (${primaryAdmin}) is not a member of "${groupName}"`);
            }
          } catch (e) {
            console.error(`[GROUPS] Could not verify admin status for "${groupName}":`, e.message);
          }
        }
      } else {
        console.log(`[GROUPS] WARNING: Group "${groupName}" not found. Make sure the bot is a member.`);
      }
    }
  } catch (error) {
    console.error('[GROUPS] Error fetching groups:', error.message);
  }
}

/**
 * Check if a group is monitored
 * @param {string} groupId - Group chat ID
 * @returns {boolean}
 */
function isMonitoredGroup(groupId) {
  const groupName = groupIdToName[groupId];
  if (!groupName) return false;
  return config.groupsToMonitor.some(name => name.toLowerCase() === groupName.toLowerCase());
}

/**
 * Get group name by ID (from cache)
 * @param {string} groupId - Group chat ID
 * @returns {string} Group name or ID if not found
 */
function getGroupNameFromConfig(groupId) {
  return groupIdToName[groupId] || groupId;
}

/**
 * Get group ID by name (from cache)
 * @param {string} groupName - Group name
 * @returns {string|null} Group ID or null if not found
 */
function getGroupIdByName(groupName) {
  return groupNameToId[groupName.toLowerCase()] || null;
}

/**
 * Get all monitored group IDs
 * @returns {Array<{name: string, id: string}>} Array of monitored groups
 */
function getMonitoredGroups() {
  return config.groupsToMonitor
    .map(name => ({
      name,
      id: groupNameToId[name.toLowerCase()]
    }))
    .filter(g => g.id);
}

/**
 * Format phone for display (partial mask)
 * @param {string} phone - Phone number
 * @returns {string}
 */
function maskPhone(phone) {
  if (!phone) return '****';
  const clean = phone.replace('@s.whatsapp.net', '').replace('@g.us', '');
  if (clean.length > 6) {
    return clean.substring(0, 4) + '****' + clean.substring(clean.length - 2);
  }
  return '****';
}

/**
 * Extract phone number from JID
 * @param {string} jid - WhatsApp JID
 * @returns {string}
 */
function jidToPhone(jid) {
  if (!jid) return '';
  return jid.replace('@s.whatsapp.net', '').replace('@g.us', '').split(':')[0];
}

/**
 * Format notification message for user whose message was deleted
 * @param {Object} moderationResult - Moderation result
 * @param {string} groupName - Group name
 * @returns {string} Formatted message
 */
function formatUserNotification(moderationResult, groupName) {
  const reasons = {
    'excessive_links': 'contains too many links (maximum 3 allowed)',
    'excessive_caps': 'contains too many capital letters (appears to be shouting)',
    'repeated_message': 'is a repeated message (spam)',
    'toxic_content': 'contains inappropriate or toxic content',
    'sensitive_topic': 'contains a sensitive or controversial topic that is not allowed in this group',
    'sensitive_image': 'contains an image with sensitive or controversial content that is not allowed in this group'
  };

  const reason = reasons[moderationResult.type] || moderationResult.reason;

  return `⚠️ *Your message was deleted*

*Group:* ${groupName}
*Reason:* Your message ${reason}.

Please follow the group rules to maintain a pleasant environment for everyone.

If you believe this was an error, please contact an administrator.`;
}

// ==================== BAILEYS CLIENT ====================

// Verification check interval (every minute)
const VERIFICATION_CHECK_INTERVAL = 60 * 1000;
let verificationInterval = null;

async function startBot() {
  // Use multi-file auth state for session persistence
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

  // Fetch latest Baileys version
  const { version } = await fetchLatestBaileysVersion();
  console.log(`[INIT] Using Baileys version: ${version.join('.')}`);

  // Create socket connection
  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['WhatsApp Bot', 'Chrome', '120.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    // Required for group events to work properly
    getMessage: async (key) => {
      return { conversation: '' };
    }
  });

  // Handle connection updates
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Display QR code
    if (qr) {
      console.log('\n[QR] Scan this QR code to authenticate:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`[DISCONNECTED] Connection closed. Status: ${statusCode}`);
      botNumber = null;

      if (verificationInterval) {
        clearInterval(verificationInterval);
        verificationInterval = null;
      }

      if (shouldReconnect) {
        console.log('[RECONNECT] Reconnecting in 15 seconds...');
        setTimeout(startBot, 15000);
      } else {
        console.log('[LOGOUT] Logged out. Delete auth_info folder and restart to re-authenticate.');
      }
    }

    if (connection === 'open') {
      console.log('[READY] WhatsApp bot is connected!');

      // Get bot's own number
      botNumber = jidToPhone(sock.user?.id);
      console.log(`[INFO] Bot number: ${botNumber}`);

      // Build group name -> ID mapping
      await buildGroupMapping();
      console.log(`[INFO] Configured to monitor: ${config.groupsToMonitor.join(', ')}`);

      // Start verification check interval
      verificationInterval = setInterval(async () => {
        try {
          const kicked = await verification.processExpiredVerifications(sock);
          if (kicked.length > 0) {
            console.log(`[VERIFY] Processed ${kicked.length} expired verifications`);
          }
        } catch (error) {
          console.error('[VERIFY] Error processing expired verifications:', error.message);
        }
      }, VERIFICATION_CHECK_INTERVAL);

      console.log('[INFO] Verification check interval started (every 60 seconds)');
    }
  });

  // Save credentials on update
  sock.ev.on('creds.update', saveCreds);

  // Handle group participant updates (join/leave)
  sock.ev.on('group-participants.update', async (update) => {
    const { id: groupId, participants, action } = update;

    // Debug: Log ALL participant updates
    console.log(`[DEBUG] group-participants.update received: action=${action}, groupId=${groupId}, participants=${participants.join(', ')}`);

    if (!isMonitoredGroup(groupId)) {
      console.log(`[DEBUG] Group ${groupId} is not monitored, skipping`);
      return;
    }

    if (action === 'add') {
      console.log(`[JOIN] New member(s) joined group ${groupId}`);

      for (const participant of participants) {
        const phone = jidToPhone(participant);

        // Skip if it's the bot itself
        if (phone === botNumber) {
          console.log('[JOIN] Bot was added to group, skipping verification');
          continue;
        }

        try {
          const groupMetadata = await sock.groupMetadata(groupId);
          console.log(`[JOIN] Starting verification for ${phone} in ${groupMetadata.subject}`);
          await verification.startVerification(sock, groupId, groupMetadata.subject, participant);
        } catch (error) {
          console.error(`[JOIN] Error handling group join: ${error.message}`);
        }
      }
    }
  });

  // Handle incoming messages
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const message of messages) {
      try {
        // Check for system messages about users joining (alternative detection)
        if (message.messageStubType) {
          console.log(`[DEBUG] System message: stubType=${message.messageStubType}, remoteJid=${message.key?.remoteJid}`);

          // messageStubType 27 = user joined, 28 = user was added
          if ((message.messageStubType === 27 || message.messageStubType === 28) &&
              message.key?.remoteJid?.endsWith('@g.us') &&
              isMonitoredGroup(message.key.remoteJid)) {

            const groupId = message.key.remoteJid;
            const participants = message.messageStubParameters || [];

            console.log(`[JOIN-ALT] Detected join via system message: group=${groupId}, participants=${participants.join(', ')}`);

            for (const participantJid of participants) {
              const phone = jidToPhone(participantJid);

              if (phone === botNumber) {
                continue;
              }

              try {
                const groupMetadata = await sock.groupMetadata(groupId);
                console.log(`[JOIN-ALT] Starting verification for ${phone} in ${groupMetadata.subject}`);
                await verification.startVerification(sock, groupId, groupMetadata.subject, participantJid);
              } catch (error) {
                console.error(`[JOIN-ALT] Error: ${error.message}`);
              }
            }
          }
        }

        // Skip if no message content
        if (!message.message) continue;

        const remoteJid = message.key.remoteJid;

        // Only process group messages from monitored groups
        if (!remoteJid.endsWith('@g.us') || !isMonitoredGroup(remoteJid)) {
          continue;
        }

        // Skip messages from self
        if (message.key.fromMe) {
          continue;
        }

        const senderJid = message.key.participant || message.key.remoteJid;
        const senderPhone = jidToPhone(senderJid);
        const senderName = message.pushName || null; // Get sender's display name

        // Get message text
        const messageText = message.message.conversation ||
          message.message.extendedTextMessage?.text ||
          '';

        // Check if message contains an image
        const imageMessage = message.message.imageMessage ||
          message.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
        const hasImage = !!imageMessage;

        // Skip if no text and no image
        if (!messageText && !hasImage) continue;

        // Get group name from config (fallback to WhatsApp metadata)
        let groupName = getGroupNameFromConfig(remoteJid);
        if (groupName === remoteJid) {
          try {
            const groupMetadata = await sock.groupMetadata(remoteJid);
            groupName = groupMetadata.subject;
          } catch (e) {}
        }

        // Save message to database (for text messages)
        if (messageText) {
          db.saveMessage({
            groupId: remoteJid,
            phone: senderPhone,
            messageBody: messageText,
            isFromAdmin: false,
            isFromBot: false
          });
          console.log(`[MSG] Saved message from ${maskPhone(senderPhone)} in group`);
        }

        // Check if sender is a group admin (skip moderation for admins)
        let isGroupAdmin = false;
        try {
          const groupMetadata = await sock.groupMetadata(remoteJid);
          const participant = groupMetadata.participants.find(p => p.id === senderJid || jidToPhone(p.id) === senderPhone);
          if (participant && (participant.admin === 'admin' || participant.admin === 'superadmin')) {
            isGroupAdmin = true;
            console.log(`[MODERATION] Skipping moderation for group admin: ${maskPhone(senderPhone)}`);
          }
        } catch (e) {
          console.error('[MODERATION] Could not check admin status:', e.message);
        }

        // Run moderation check (skip for group admins)
        if (!isGroupAdmin) {
          let moderationResult = null;

          // Check image first if present
          if (hasImage) {
            try {
              console.log(`[MODERATION] Analyzing image from ${maskPhone(senderPhone)}...`);
              const imageBuffer = await downloadMediaMessage(message, 'buffer', {});
              const mimeType = imageMessage?.mimetype || 'image/jpeg';
              moderationResult = await moderation.analyzeImage(imageBuffer, mimeType);

              if (moderationResult) {
                console.log(`[MODERATION] Image violation: ${moderationResult.description}`);
              }
            } catch (imgError) {
              console.error('[MODERATION] Could not analyze image:', imgError.message);
            }
          }

          // If no image violation, check text
          if (!moderationResult && messageText) {
            moderationResult = await moderation.moderateMessage(messageText, senderPhone, remoteJid);
          }

          if (moderationResult) {
            console.log(`[MODERATION] Violation detected: ${moderationResult.type} - ${moderationResult.reason}`);

            // For images, use the description; for text, use the messageText
            const logMessageBody = moderationResult.type === 'sensitive_image'
              ? `[IMAGE] ${moderationResult.description}`
              : messageText;

            // Log to database with message key for potential restoration
            const logId = db.logModeration({
              groupId: remoteJid,
              userPhone: senderPhone,
              userName: senderName,
              messageBody: logMessageBody,
              violationType: moderationResult.type,
              actionTaken: 'deleted',
              categoryScores: moderationResult.categoryScores,
              messageKey: message.key
            });

            // Try to delete the message
            try {
              await sock.sendMessage(remoteJid, { delete: message.key });
              console.log('[MODERATION] Message deleted');
            } catch (deleteError) {
              console.error('[MODERATION] Could not delete message:', deleteError.message);
            }

            // Notify the user via private message explaining why
            try {
              const userNotification = formatUserNotification(moderationResult, groupName);
              await sock.sendMessage(senderJid, { text: userNotification });
              console.log(`[MODERATION] User ${maskPhone(senderPhone)} notified`);
            } catch (userNotifyError) {
              console.error('[MODERATION] Could not notify user:', userNotifyError.message);
            }
          }
        }

        // Check if this is a verification answer
        const verificationResult = await verification.checkVerificationAnswer(
          senderJid,
          messageText,
          remoteJid,
          groupName
        );

        if (verificationResult) {
          try {
            await sock.sendMessage(remoteJid, { text: verificationResult.message });
          } catch (sendError) {
            console.error('[MSG] Error sending verification response:', sendError.message);
          }

          if (verificationResult.success) {
            console.log(`[VERIFY] ${maskPhone(verificationResult.phone)} passed verification!`);
          }
        }
      } catch (error) {
        console.error('[MSG] Error processing message:', error.message);
      }
    }
  });

  // Log that all event listeners are registered
  console.log('[INIT] All event listeners registered (connection.update, creds.update, group-participants.update, messages.upsert)');

  // Process buffered events (required in newer Baileys versions)
  sock.ev.process(async (events) => {
    if (events['group-participants.update']) {
      const update = events['group-participants.update'];
      console.log(`[DEBUG-BUFFER] group-participants.update from buffer: ${JSON.stringify(update)}`);
    }
  });
}

// ==================== GRACEFUL SHUTDOWN ====================

process.on('SIGINT', async () => {
  console.log('\n[SHUTDOWN] Received SIGINT, shutting down gracefully...');

  if (verificationInterval) {
    clearInterval(verificationInterval);
  }

  if (sock) {
    sock.end();
    console.log('[SHUTDOWN] WhatsApp connection closed');
  }

  db.close();
  console.log('[SHUTDOWN] Database closed');
  console.log('[SHUTDOWN] Goodbye!');
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[ERROR] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[ERROR] Uncaught Exception:', error);
});

// ==================== START BOT ====================

console.log('[INIT] Starting WhatsApp bot with Baileys...');
console.log('[INIT] Verification timeout:', config.verificationTimeoutMinutes, 'minutes');
console.log('[INIT] Moderation: Spam detection + OpenAI Moderation API enabled');
console.log('[INIT] Weekly Summary: Available via web dashboard button');

startBot();
