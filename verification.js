const db = require('./db');
const config = require('./config.json');
const captcha = require('./captcha');

// Language detection keywords for Dutch groups
const DUTCH_KEYWORDS = ['nederland', 'dutch', 'nl', 'holland', 'vlaams', 'belgie', 'belgian'];

// Multilingual messages
const MESSAGES = {
  en: {
    welcome: (timeout) =>
      `Welcome! To verify you're human, please type the code shown in the image within ${timeout} minutes.\n\n` +
      `The code is case-insensitive (you can type lowercase or uppercase).`,
    success: 'Verification successful! Welcome to the group.',
    wrong: 'That code is not correct. Please look at the image and try again.',
    timeout: 'Verification time expired. You will be removed from the group.',
    alreadyVerified: 'You are already verified!'
  },
  nl: {
    welcome: (timeout) =>
      `Welkom! Om te bevestigen dat je een mens bent, typ de code die in de afbeelding wordt getoond binnen ${timeout} minuten.\n\n` +
      `De code is niet hoofdlettergevoelig.`,
    success: 'Verificatie geslaagd! Welkom in de groep.',
    wrong: 'Die code is niet correct. Kijk naar de afbeelding en probeer opnieuw.',
    timeout: 'Verificatietijd verlopen. Je wordt uit de groep verwijderd.',
    alreadyVerified: 'Je bent al geverifieerd!'
  }
};

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
 * Detect language based on group name
 * @param {string} groupName - Name of the group
 * @returns {string} Language code ('en' or 'nl')
 */
function detectLanguage(groupName) {
  const lowerName = (groupName || '').toLowerCase();

  for (const keyword of DUTCH_KEYWORDS) {
    if (lowerName.includes(keyword)) {
      console.log(`[VERIFY] Detected Dutch language for group: ${groupName}`);
      return 'nl';
    }
  }

  console.log(`[VERIFY] Using English for group: ${groupName}`);
  return 'en';
}

/**
 * Get messages in the appropriate language
 * @param {string} groupName - Name of the group
 * @returns {Object} Messages object for the detected language
 */
function getMessages(groupName) {
  const lang = detectLanguage(groupName);
  return MESSAGES[lang];
}

/**
 * Start verification process for a new member with image captcha (Baileys version)
 * @param {Object} sock - Baileys socket
 * @param {string} groupId - Group JID
 * @param {string} groupName - Group name
 * @param {string} userJid - New member's JID
 */
async function startVerification(sock, groupId, groupName, userJid) {
  const userPhone = jidToPhone(userJid);
  const messages = getMessages(groupName);
  const timeout = config.verificationTimeoutMinutes;

  // Check if already verified
  if (db.isUserVerified(userPhone, groupId)) {
    console.log(`[VERIFY] User ${userPhone} is already verified in ${groupId}`);
    return;
  }

  // Generate captcha
  const { code, image } = await captcha.generateCaptcha(200, 80, 5);

  // Add pending captcha verification to database
  db.addPendingCaptcha(userPhone, groupId, code, timeout);

  // Send welcome message with captcha image
  const welcomeMsg = messages.welcome(timeout);

  try {
    // Send the captcha image
    await sock.sendMessage(groupId, {
      image: image,
      caption: `Welcome new member!\n\n${welcomeMsg}`
    });
    console.log(`[VERIFY] Captcha verification started for ${userPhone} in group ${groupName} (code: ${code})`);
  } catch (error) {
    console.error(`[VERIFY] Error sending captcha: ${error.message}`);
  }
}

/**
 * Check if a message is a captcha answer (Baileys version)
 * @param {string} senderJid - Sender's JID
 * @param {string} messageText - Message text
 * @param {string} groupId - Group JID
 * @param {string} groupName - Group name
 * @returns {Object|null} Result with success status and response message
 */
async function checkVerificationAnswer(senderJid, messageText, groupId, groupName) {
  const phone = jidToPhone(senderJid);

  // Get pending verification
  const pending = db.getPendingVerification(phone, groupId);

  if (!pending || !pending.captcha_code) {
    return null; // No pending captcha verification for this user
  }

  const messages = getMessages(groupName);
  const userAnswer = messageText.trim().toUpperCase();
  const expectedCode = pending.captcha_code.toUpperCase();

  // Check if the answer matches the captcha code
  if (userAnswer === expectedCode) {
    // Correct answer
    db.removePendingVerification(phone, groupId);
    db.markUserVerified(phone, groupId);

    console.log(`[VERIFY] User ${phone} verified successfully in ${groupId}`);

    return {
      success: true,
      message: messages.success,
      phone: phone
    };
  } else {
    // Check if it looks like a captcha attempt (alphanumeric, similar length)
    if (/^[A-Z0-9]{3,7}$/i.test(messageText.trim())) {
      console.log(`[VERIFY] Wrong captcha from ${phone}: "${userAnswer}" (expected "${expectedCode}")`);

      return {
        success: false,
        message: messages.wrong,
        phone: phone
      };
    }

    // Not a captcha attempt, ignore
    return null;
  }
}

/**
 * Process expired verifications and kick users (Baileys version)
 * @param {Object} sock - Baileys socket
 * @returns {Array} List of kicked users
 */
async function processExpiredVerifications(sock) {
  const expired = db.getExpiredVerifications();
  const kicked = [];

  for (const verification of expired) {
    try {
      // Get group metadata for language detection
      let groupName = verification.group_id;
      try {
        const groupMetadata = await sock.groupMetadata(verification.group_id);
        groupName = groupMetadata.subject;
      } catch (e) {}

      const messages = getMessages(groupName);

      // Send timeout message
      try {
        await sock.sendMessage(verification.group_id, { text: messages.timeout });
      } catch (msgError) {
        console.error(`[VERIFY] Error sending timeout message: ${msgError.message}`);
      }

      // Try to remove user from group
      // Handle both LID format (already has @lid) and phone format
      let participantJid = verification.phone;
      if (!participantJid.includes('@')) {
        participantJid = participantJid + '@s.whatsapp.net';
      }

      console.log(`[VERIFY] Attempting to kick ${participantJid} from ${verification.group_id}`);

      try {
        await sock.groupParticipantsUpdate(
          verification.group_id,
          [participantJid],
          'remove'
        );
        console.log(`[VERIFY] Kicked ${verification.phone} from ${verification.group_id} (timeout)`);
        kicked.push({ phone: verification.phone, groupId: verification.group_id });
      } catch (kickError) {
        console.error(`[VERIFY] Could not kick ${verification.phone}: ${kickError.message}`);
      }
    } catch (error) {
      console.error(`[VERIFY] Error processing expired verification for ${verification.phone}: ${error.message}`);
    }
  }

  // Clean up expired records
  db.cleanupExpiredVerifications();

  return kicked;
}

module.exports = {
  detectLanguage,
  getMessages,
  startVerification,
  checkVerificationAnswer,
  processExpiredVerifications,
  jidToPhone,
  MESSAGES
};
