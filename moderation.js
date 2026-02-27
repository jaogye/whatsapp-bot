const OpenAI = require('openai');
const db = require('./db');
const config = require('./config.json');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const os = require('os');

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
// NOTE: Keyword detection is currently disabled, this list is kept for reference
const SENSITIVE_TOPICS = [
  'politics', 'politicians', 'political parties', 'elections', 'voting', 'government',
  'religion', 'religious', 'god', 'church', 'mosque', 'temple', 'bible', 'quran', 'conversion',
  'caste', 'reservation', 'dalit', 'brahmin', 'caste system', 'untouchable',
  'feminism', 'feminist', 'men\'s rights', 'gender war', 'patriarchy', 'misogyny', 'misandry',
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
          content: `You are a content moderator. Analyze if the message contains any of these sensitive or prohibited topics:
1. Politics / politicians / parties / elections
2. Religion / religious figures / practices / conversions
3. Castes / reservation system / caste-based content
4. Gender wars / feminism vs. men's rights
5. Racism / skin color / regionalism / ethnic stereotypes
6. Vaccines / COVID / 5G / pharmaceutical conspiracy theories
7. Abortion / pro-life vs. pro-choice
8. Scams and fraud: AI romance scams, catfishing, fake investments, crypto scams, pig butchering, HYIP schemes, fake online stores, unrealistic discounts, phishing, identity theft, impersonation, BEC, voice cloning, fake job offers, task scams, employment scams, fake giveaways, fake lotteries, non-existent prizes, deepfake scams, recovery scams, fake immigration help, fake charity, malicious ads

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
          content: `You are a content moderator analyzing images. Check if the image contains any of these prohibited content types:
1. Politics / politicians / political parties / elections / campaigns
2. Religion / religious figures / religious practices / conversions
3. Castes / reservation system / caste-based content
4. Gender wars / feminism vs. men's rights content
5. Racism / skin color discrimination / regionalism / ethnic stereotypes
6. Vaccines / COVID / 5G / pharmaceutical conspiracy theories
7. Abortion / pro-life vs. pro-choice imagery
8. Medical/graphic content: blood, wounds, injuries, bruises, bumps, trauma, gore
9. Commercial advertising: products for sale, services promotion, business ads, sales posts
10. Scams and fraud imagery: fake investment promotions, crypto scams, get-rich-quick schemes, fake giveaways, lottery scams, phishing attempts, fake job offers, deepfake content, fake charity appeals, too-good-to-be-true offers, suspicious money transfer requests, fake online store promotions

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

// Content moderation prompt for video/GIF analysis (same categories as images)
const VIDEO_MODERATION_PROMPT = `You are a content moderator analyzing video frames. Check if ANY of the frames contain these prohibited content types:
1. Politics / politicians / political parties / elections / campaigns
2. Religion / religious figures / religious practices / conversions
3. Castes / reservation system / caste-based content
4. Gender wars / feminism vs. men's rights content
5. Racism / skin color discrimination / regionalism / ethnic stereotypes
6. Vaccines / COVID / 5G / pharmaceutical conspiracy theories
7. Abortion / pro-life vs. pro-choice imagery
8. Medical/graphic content: blood, wounds, injuries, bruises, bumps, trauma, gore
9. Commercial advertising: products for sale, services promotion, business ads, sales posts
10. Scams and fraud imagery: fake investment promotions, crypto scams, get-rich-quick schemes, fake giveaways, lottery scams, phishing attempts, fake job offers, deepfake content, fake charity appeals, too-good-to-be-true offers, suspicious money transfer requests, fake online store promotions

Analyze ALL frames together as they represent a video/GIF. If ANY frame contains prohibited content, flag it.

Respond with JSON only:
{
  "flagged": true/false,
  "topic": "topic name if flagged, null otherwise",
  "description": "brief 10-15 word description of what the video/GIF shows",
  "confidence": 0.0-1.0
}`;

/**
 * Extract frames from a video file using ffmpeg
 * @param {Buffer} videoBuffer - Video data as buffer
 * @param {number} numFrames - Number of frames to extract (default 4)
 * @returns {Promise<Buffer[]>} Array of frame buffers as JPEG
 */
async function extractVideoFrames(videoBuffer, numFrames = 4) {
  const tempDir = os.tmpdir();
  const tempVideoPath = path.join(tempDir, `video_${Date.now()}.mp4`);
  const framePattern = path.join(tempDir, `frame_${Date.now()}_%d.jpg`);
  const frames = [];

  try {
    // Write video buffer to temp file
    fs.writeFileSync(tempVideoPath, videoBuffer);

    // Get video duration first
    const duration = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(tempVideoPath, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata.format.duration || 5);
      });
    });

    // Calculate frame extraction timestamps
    const interval = duration / (numFrames + 1);
    const timestamps = [];
    for (let i = 1; i <= numFrames; i++) {
      timestamps.push(interval * i);
    }

    // Extract frames at calculated timestamps
    await new Promise((resolve, reject) => {
      let command = ffmpeg(tempVideoPath)
        .outputOptions([
          '-vf', `select='${timestamps.map((t, i) => `eq(n\\,${Math.floor(t * 30)})`).join('+')}',scale=512:-1`,
          '-vsync', 'vfr',
          '-frames:v', numFrames.toString(),
          '-q:v', '2'
        ])
        .output(framePattern)
        .on('end', resolve)
        .on('error', (err) => {
          // Fallback: extract frames at regular intervals
          ffmpeg(tempVideoPath)
            .outputOptions([
              '-vf', `fps=1/${Math.max(1, Math.floor(duration / numFrames))},scale=512:-1`,
              '-frames:v', numFrames.toString(),
              '-q:v', '2'
            ])
            .output(framePattern)
            .on('end', resolve)
            .on('error', reject)
            .run();
        });
      command.run();
    });

    // Read extracted frames
    for (let i = 1; i <= numFrames; i++) {
      const framePath = path.join(tempDir, `frame_${Date.now() - (Date.now() % 1000)}_${i}.jpg`)
        .replace(`_${i}.jpg`, `_${i}.jpg`);

      // Try to find the frame file
      const files = fs.readdirSync(tempDir).filter(f =>
        f.startsWith(`frame_`) && f.endsWith('.jpg')
      );

      for (const file of files) {
        const filePath = path.join(tempDir, file);
        if (fs.existsSync(filePath)) {
          const frameBuffer = fs.readFileSync(filePath);
          frames.push(frameBuffer);
          fs.unlinkSync(filePath); // Clean up
        }
      }
      break; // Only need to scan once
    }

    // Clean up temp video file
    if (fs.existsSync(tempVideoPath)) {
      fs.unlinkSync(tempVideoPath);
    }

    return frames;
  } catch (error) {
    // Clean up on error
    if (fs.existsSync(tempVideoPath)) {
      fs.unlinkSync(tempVideoPath);
    }
    throw error;
  }
}

/**
 * Extract frames from a GIF file
 * @param {Buffer} gifBuffer - GIF data as buffer
 * @param {number} numFrames - Number of frames to extract (default 4)
 * @returns {Promise<Buffer[]>} Array of frame buffers as JPEG
 */
async function extractGifFrames(gifBuffer, numFrames = 4) {
  const tempDir = os.tmpdir();
  const tempGifPath = path.join(tempDir, `gif_${Date.now()}.gif`);
  const framePattern = path.join(tempDir, `gifframe_${Date.now()}_%d.jpg`);
  const frames = [];

  try {
    // Write GIF buffer to temp file
    fs.writeFileSync(tempGifPath, gifBuffer);

    // Use ffmpeg to extract frames from GIF
    await new Promise((resolve, reject) => {
      ffmpeg(tempGifPath)
        .outputOptions([
          '-vf', `select='not(mod(n\\,5))',scale=512:-1`, // Select every 5th frame
          '-frames:v', numFrames.toString(),
          '-q:v', '2'
        ])
        .output(framePattern)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Read extracted frames
    const files = fs.readdirSync(tempDir)
      .filter(f => f.startsWith(`gifframe_`) && f.endsWith('.jpg'))
      .sort();

    for (const file of files.slice(0, numFrames)) {
      const filePath = path.join(tempDir, file);
      if (fs.existsSync(filePath)) {
        frames.push(fs.readFileSync(filePath));
        fs.unlinkSync(filePath); // Clean up
      }
    }

    // Clean up temp GIF file
    if (fs.existsSync(tempGifPath)) {
      fs.unlinkSync(tempGifPath);
    }

    return frames;
  } catch (error) {
    // Clean up on error
    if (fs.existsSync(tempGifPath)) {
      fs.unlinkSync(tempGifPath);
    }
    throw error;
  }
}

/**
 * Analyze video for sensitive content using OpenAI Vision API
 * @param {Buffer} videoBuffer - Video data as buffer
 * @param {string} mimeType - Video MIME type
 * @returns {Promise<Object|null>} Detection result or null
 */
async function analyzeVideo(videoBuffer, mimeType = 'video/mp4') {
  if (!videoBuffer) return null;
  if (!config.openaiApiKey) {
    console.log('[MODERATION] OpenAI API key not configured, skipping video analysis');
    return null;
  }

  try {
    console.log('[MODERATION] Extracting frames from video...');
    const frames = await extractVideoFrames(videoBuffer, 4);

    if (frames.length === 0) {
      console.log('[MODERATION] Could not extract frames from video');
      return null;
    }

    console.log(`[MODERATION] Analyzing ${frames.length} video frames...`);

    // Build content array with all frames
    const imageContent = frames.map(frame => ({
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${frame.toString('base64')}`,
        detail: 'low'
      }
    }));

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: VIDEO_MODERATION_PROMPT
        },
        {
          role: 'user',
          content: [
            ...imageContent,
            {
              type: 'text',
              text: `Analyze these ${frames.length} frames extracted from a video for sensitive or prohibited content.`
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
      let jsonStr = responseText;
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '');
      }
      result = JSON.parse(jsonStr);
    } catch (e) {
      console.error('[MODERATION] Could not parse video analysis response:', responseText);
      return null;
    }

    if (result.flagged && result.confidence > 0.6) {
      return {
        type: 'sensitive_video',
        reason: `Video contains sensitive topic: ${result.topic}`,
        severity: 'high',
        topic: result.topic,
        description: result.description || 'Sensitive video content',
        confidence: result.confidence
      };
    }

    return null;
  } catch (error) {
    console.error('[MODERATION] Video analysis error:', error.message);
    return null;
  }
}

/**
 * Analyze GIF for sensitive content using OpenAI Vision API
 * @param {Buffer} gifBuffer - GIF data as buffer
 * @returns {Promise<Object|null>} Detection result or null
 */
async function analyzeGif(gifBuffer) {
  if (!gifBuffer) return null;
  if (!config.openaiApiKey) {
    console.log('[MODERATION] OpenAI API key not configured, skipping GIF analysis');
    return null;
  }

  try {
    console.log('[MODERATION] Extracting frames from GIF...');
    const frames = await extractGifFrames(gifBuffer, 4);

    if (frames.length === 0) {
      console.log('[MODERATION] Could not extract frames from GIF');
      return null;
    }

    console.log(`[MODERATION] Analyzing ${frames.length} GIF frames...`);

    // Build content array with all frames
    const imageContent = frames.map(frame => ({
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${frame.toString('base64')}`,
        detail: 'low'
      }
    }));

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: VIDEO_MODERATION_PROMPT
        },
        {
          role: 'user',
          content: [
            ...imageContent,
            {
              type: 'text',
              text: `Analyze these ${frames.length} frames extracted from a GIF for sensitive or prohibited content.`
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
      let jsonStr = responseText;
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '');
      }
      result = JSON.parse(jsonStr);
    } catch (e) {
      console.error('[MODERATION] Could not parse GIF analysis response:', responseText);
      return null;
    }

    if (result.flagged && result.confidence > 0.6) {
      return {
        type: 'sensitive_gif',
        reason: `GIF contains sensitive topic: ${result.topic}`,
        severity: 'high',
        topic: result.topic,
        description: result.description || 'Sensitive GIF content',
        confidence: result.confidence
      };
    }

    return null;
  } catch (error) {
    console.error('[MODERATION] GIF analysis error:', error.message);
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

  // NOTE: Keyword-based sensitive topic detection has been disabled
  // AI-based detection (checkSensitiveContent) is still active below

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
  analyzeVideo,
  analyzeGif,
  moderateMessage,
  formatAdminAlert,
  createAdminButtons,
  handleAdminResponse,
  SPAM_CONFIG,
  SENSITIVE_TOPICS
};
