const OpenAI = require('openai');
const db = require('./db');
const config = require('./config.json');

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: config.openaiApiKey
});

// Spam detection thresholds
const SPAM_CONFIG = {
  maxLinks: 3,
  maxCapsRatio: 0.7,
  minCapsLength: 10,
  repeatThreshold: 3,
  repeatWindow: 60000 // 1 minute
};

// Sensitive topics that should be moderated
const SENSITIVE_TOPICS = [
  'politics', 'politicians', 'political parties', 'elections', 'voting', 'government',
  'religion', 'religious', 'god', 'church', 'mosque', 'temple', 'bible', 'quran', 'conversion',
  'caste', 'reservation', 'dalit', 'brahmin', 'caste system', 'untouchable',
  'feminism', 'feminist', 'men\'s rights', 'gender war', 'patriarchy', 'misogyny', 'misandry',
  'lgbtq', 'lgbt', 'gay', 'lesbian', 'transgender', 'trans rights', 'same-sex marriage', 'homosexual',
  'racism', 'racist', 'skin color', 'north india', 'south india', 'regionalism', 'ethnic',
  'vaccine', 'covid', 'corona', '5g', 'conspiracy', 'big pharma', 'anti-vax', 'microchip',
  'abortion', 'pro-life', 'pro-choice', 'prolife', 'prochoice'
];

// Keywords for quick detection (lowercase)
const SENSITIVE_KEYWORDS_REGEX = new RegExp(
  SENSITIVE_TOPICS.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'i'
);

// Track recent messages for repeat detection
const recentMessages = new Map();

/**
 * Clean old entries from recent messages cache
 */
function cleanRecentMessages() {
  const now = Date.now();
  for (const [key, data] of recentMessages.entries()) {
    if (now - data.lastTime > SPAM_CONFIG.repeatWindow) {
      recentMessages.delete(key);
    }
  }
}

/**
 * Check for simple spam patterns
 * @param {string} message - Message text
 * @param {string} senderPhone - Sender's phone
 * @param {string} groupId - Group ID
 * @returns {Object|null} Spam detection result or null
 */
function checkSimpleSpam(message, senderPhone, groupId) {
  if (!message || message.length < 5) return null;

  // Check for excessive links
  const linkCount = (message.match(/https?:\/\/[^\s]+/gi) || []).length;
  if (linkCount > SPAM_CONFIG.maxLinks) {
    return {
      type: 'excessive_links',
      reason: `Message contains ${linkCount} links (max: ${SPAM_CONFIG.maxLinks})`,
      severity: 'medium'
    };
  }

  // Check for excessive caps
  if (message.length >= SPAM_CONFIG.minCapsLength) {
    const letters = message.replace(/[^a-zA-Z]/g, '');
    if (letters.length > 0) {
      const capsRatio = (letters.match(/[A-Z]/g) || []).length / letters.length;
      if (capsRatio > SPAM_CONFIG.maxCapsRatio) {
        return {
          type: 'excessive_caps',
          reason: `Message is ${Math.round(capsRatio * 100)}% uppercase`,
          severity: 'low'
        };
      }
    }
  }

  // Check for repeated messages
  cleanRecentMessages();
  const key = `${senderPhone}:${groupId}`;
  const messageHash = message.toLowerCase().trim();

  if (recentMessages.has(key)) {
    const data = recentMessages.get(key);
    if (data.message === messageHash) {
      data.count++;
      data.lastTime = Date.now();
      if (data.count >= SPAM_CONFIG.repeatThreshold) {
        return {
          type: 'repeated_message',
          reason: `Same message sent ${data.count} times`,
          severity: 'medium'
        };
      }
    } else {
      recentMessages.set(key, { message: messageHash, count: 1, lastTime: Date.now() });
    }
  } else {
    recentMessages.set(key, { message: messageHash, count: 1, lastTime: Date.now() });
  }

  return null;
}

/**
 * Quick check for sensitive topics using keywords
 * @param {string} message - Message text
 * @returns {Object|null} Detection result or null
 */
function checkSensitiveKeywords(message) {
  if (!message || message.length < 3) return null;

  const lowerMessage = message.toLowerCase();

  if (SENSITIVE_KEYWORDS_REGEX.test(lowerMessage)) {
    // Find which keywords matched
    const matchedTopics = SENSITIVE_TOPICS.filter(topic =>
      lowerMessage.includes(topic.toLowerCase())
    );

    if (matchedTopics.length > 0) {
      return {
        type: 'sensitive_topic',
        reason: `Contains sensitive topic: ${matchedTopics[0]}`,
        severity: 'high',
        matchedTopics
      };
    }
  }

  return null;
}

/**
 * Check for sensitive content using OpenAI (more intelligent detection)
 * @param {string} message - Message text
 * @returns {Promise<Object|null>} Detection result or null
 */
async function checkSensitiveContent(message) {
  if (!message || message.length < 10) return null;
  if (!config.openaiApiKey) return null;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a content moderator. Analyze if the message contains any of these sensitive topics:
1. Politics / politicians / parties / elections
2. Religion / religious figures / practices / conversions
3. Castes / reservation system / caste-based content
4. Gender wars / feminism vs. men's rights
5. LGBTQ+ topics / transgender rights / same-sex marriage
6. Racism / skin color / regionalism / ethnic stereotypes
7. Vaccines / COVID / 5G / pharmaceutical conspiracy theories
8. Abortion / pro-life vs. pro-choice

Respond with JSON only: {"flagged": true/false, "topic": "topic name or null", "confidence": 0.0-1.0}`
        },
        {
          role: 'user',
          content: message
        }
      ],
      temperature: 0.1,
      max_tokens: 100
    });

    const responseText = response.choices[0].message.content.trim();
    let result;

    try {
      // Handle potential markdown wrapping
      let jsonStr = responseText;
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '');
      }
      result = JSON.parse(jsonStr);
    } catch (e) {
      return null;
    }

    if (result.flagged && result.confidence > 0.7) {
      return {
        type: 'sensitive_topic',
        reason: `Detected sensitive topic: ${result.topic}`,
        severity: 'high',
        topic: result.topic,
        confidence: result.confidence
      };
    }

    return null;
  } catch (error) {
    console.error('[MODERATION] OpenAI sensitive check error:', error.message);
    return null;
  }
}

/**
 * Analyze image for sensitive content using OpenAI Vision API
 * @param {Buffer} imageBuffer - Image data as buffer
 * @param {string} mimeType - Image MIME type (image/jpeg, image/png, etc.)
 * @returns {Promise<Object|null>} Detection result or null
 */
async function analyzeImage(imageBuffer, mimeType = 'image/jpeg') {
  if (!imageBuffer) return null;
  if (!config.openaiApiKey) {
    console.log('[MODERATION] OpenAI API key not configured, skipping image analysis');
    return null;
  }

  try {
    // Convert buffer to base64
    const base64Image = imageBuffer.toString('base64');
    const dataUrl = `data:${mimeType};base64,${base64Image}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a content moderator analyzing images. Check if the image contains any of these sensitive topics:
1. Politics / politicians / political parties / elections / campaigns
2. Religion / religious figures / religious practices / conversions
3. Castes / reservation system / caste-based content
4. Gender wars / feminism vs. men's rights content
5. LGBTQ+ topics / transgender rights / same-sex marriage symbols
6. Racism / skin color discrimination / regionalism / ethnic stereotypes
7. Vaccines / COVID / 5G / pharmaceutical conspiracy theories
8. Abortion / pro-life vs. pro-choice imagery

Respond with JSON only:
{
  "flagged": true/false,
  "topic": "topic name if flagged, null otherwise",
  "description": "brief 10-15 word description of what the image shows",
  "confidence": 0.0-1.0
}`
        },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: dataUrl,
                detail: 'low'
              }
            },
            {
              type: 'text',
              text: 'Analyze this image for sensitive content.'
            }
          ]
        }
      ],
      temperature: 0.1,
      max_tokens: 200
    });

    const responseText = response.choices[0].message.content.trim();
    let result;

    try {
      // Handle potential markdown wrapping
      let jsonStr = responseText;
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '');
      }
      result = JSON.parse(jsonStr);
    } catch (e) {
      console.error('[MODERATION] Could not parse image analysis response:', responseText);
      return null;
    }

    if (result.flagged && result.confidence > 0.6) {
      return {
        type: 'sensitive_image',
        reason: `Image contains sensitive topic: ${result.topic}`,
        severity: 'high',
        topic: result.topic,
        description: result.description || 'Sensitive image content',
        confidence: result.confidence
      };
    }

    return null;
  } catch (error) {
    console.error('[MODERATION] OpenAI Vision API error:', error.message);
    return null;
  }
}

/**
 * Check for toxic content using OpenAI Moderation API
 * @param {string} message - Message text
 * @returns {Promise<Object|null>} Moderation result or null
 */
async function checkToxicContent(message) {
  if (!message || message.length < 3) return null;
  if (!config.openaiApiKey) {
    console.log('[MODERATION] OpenAI API key not configured, skipping toxic check');
    return null;
  }

  try {
    const response = await openai.moderations.create({
      input: message
    });

    const result = response.results[0];

    if (result.flagged) {
      // Find which categories were flagged
      const flaggedCategories = [];
      const highScoreCategories = [];

      for (const [category, flagged] of Object.entries(result.categories)) {
        if (flagged) {
          flaggedCategories.push(category);
        }
      }

      for (const [category, score] of Object.entries(result.category_scores)) {
        if (score > 0.75) {
          highScoreCategories.push({ category, score: Math.round(score * 100) });
        }
      }

      return {
        type: 'toxic_content',
        reason: `Flagged for: ${flaggedCategories.join(', ')}`,
        severity: 'high',
        flagged: true,
        categories: flaggedCategories,
        categoryScores: result.category_scores
      };
    }

    // Check for high scores even if not flagged
    for (const [category, score] of Object.entries(result.category_scores)) {
      if (score > 0.75) {
        return {
          type: 'toxic_content',
          reason: `High score (${Math.round(score * 100)}%) for: ${category}`,
          severity: 'medium',
          flagged: false,
          categories: [category],
          categoryScores: result.category_scores
        };
      }
    }

    return null;
  } catch (error) {
    console.error('[MODERATION] OpenAI API error:', error.message);
    return null;
  }
}

/**
 * Process a message for moderation
 * @param {string} message - Message text
 * @param {string} senderPhone - Sender's phone
 * @param {string} groupId - Group ID
 * @returns {Promise<Object|null>} Moderation result or null if message is OK
 */
async function moderateMessage(message, senderPhone, groupId) {
  // First check simple spam
  const spamResult = checkSimpleSpam(message, senderPhone, groupId);
  if (spamResult) {
    return spamResult;
  }

  // Quick check for sensitive keywords
  const keywordResult = checkSensitiveKeywords(message);
  if (keywordResult) {
    return keywordResult;
  }

  // Then check for toxic content
  const toxicResult = await checkToxicContent(message);
  if (toxicResult) {
    return toxicResult;
  }

  // Deep check for sensitive content using AI (for longer messages)
  if (message.length > 20) {
    const sensitiveResult = await checkSensitiveContent(message);
    if (sensitiveResult) {
      return sensitiveResult;
    }
  }

  return null;
}

/**
 * Format moderation alert for admins
 * @param {Object} result - Moderation result
 * @param {string} groupName - Group name
 * @param {string} senderPhone - Sender's phone (masked)
 * @param {string} message - Original message (truncated)
 * @param {number} logId - Moderation log ID
 * @returns {string} Formatted alert message
 */
function formatAdminAlert(result, groupName, senderPhone, message, logId) {
  const truncatedMsg = message.length > 100 ? message.substring(0, 100) + '...' : message;
  const maskedPhone = senderPhone.length > 6
    ? senderPhone.substring(0, 4) + '****' + senderPhone.substring(senderPhone.length - 2)
    : '****';

  return `*Moderation Alert* [ID: ${logId}]

*Group:* ${groupName}
*User:* ${maskedPhone}
*Violation:* ${result.type}
*Reason:* ${result.reason}
*Severity:* ${result.severity}

*Message:*
"${truncatedMsg}"

Reply with:
- *ignore* - No action
- *ban* - Remove user from group
- *mute* - (Coming soon)`;
}

/**
 * Create interactive buttons for admin response (with text fallback)
 * @param {number} logId - Moderation log ID
 * @returns {Object} Button message object
 */
function createAdminButtons(logId) {
  // WhatsApp interactive buttons
  return {
    text: `Moderation Action [ID: ${logId}]`,
    footer: 'Select an action',
    buttons: [
      { buttonId: `mod_ignore_${logId}`, buttonText: { displayText: 'Ignore' } },
      { buttonId: `mod_ban_${logId}`, buttonText: { displayText: 'Ban User' } },
      { buttonId: `mod_mute_${logId}`, buttonText: { displayText: 'Mute' } }
    ],
    headerType: 1
  };
}

/**
 * Handle admin response to moderation alert
 * @param {string} response - Admin response text
 * @param {Object} sock - Baileys socket
 * @param {string} groupId - Group ID
 * @param {string} userPhone - User's phone to take action on
 * @returns {Promise<string>} Action result message
 */
async function handleAdminResponse(response, sock, groupId, userPhone) {
  const action = response.toLowerCase().trim();

  if (action === 'ignore' || action.includes('ignore')) {
    return 'Action: Ignored. No action taken.';
  }

  if (action === 'ban' || action.includes('ban')) {
    try {
      let participantJid = userPhone;
      if (!participantJid.includes('@')) {
        participantJid = participantJid + '@s.whatsapp.net';
      }

      await sock.groupParticipantsUpdate(groupId, [participantJid], 'remove');
      return `Action: User ${userPhone} has been removed from the group.`;
    } catch (error) {
      return `Error banning user: ${error.message}`;
    }
  }

  if (action === 'mute' || action.includes('mute')) {
    return 'Action: Mute functionality coming soon.';
  }

  return 'Unknown action. Use: ignore, ban, or mute';
}

module.exports = {
  checkSimpleSpam,
  checkSensitiveKeywords,
  checkSensitiveContent,
  checkToxicContent,
  analyzeImage,
  moderateMessage,
  formatAdminAlert,
  createAdminButtons,
  handleAdminResponse,
  SPAM_CONFIG,
  SENSITIVE_TOPICS
};
