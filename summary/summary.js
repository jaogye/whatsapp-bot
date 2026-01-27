const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config.json');

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: config.openaiApiKey
});

// Day names for formatting
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Generate weekly summary for a single group
 * @param {string} groupId - Group ID
 * @param {string} groupName - Group name
 * @returns {Promise<Object>} Summary object
 */
async function generateGroupSummary(groupId, groupName) {
  console.log(`[SUMMARY] Generating summary for group: ${groupName}`);

  // Get messages from last 7 days (max 500)
  const messages = db.getMessagesLastDays(groupId, 7, 500);
  const totalCount = db.getTotalMessageCount(groupId, 7);
  const uniqueUsers = db.getUniqueUsersCount(groupId, 7);
  const dayStats = db.getMessageCountByDay(groupId, 7);

  if (messages.length === 0) {
    return {
      group_name: groupName,
      group_id: groupId,
      top_topics: [],
      summary: 'No messages in the last 7 days.',
      most_active_days: [],
      total_messages: 0,
      unique_users: 0,
      error: null
    };
  }

  // Format messages for analysis (truncate if needed)
  const messageTexts = messages
    .map(m => m.message_body)
    .filter(m => m && m.length > 2)
    .slice(0, 500);

  // Calculate most active days
  const mostActiveDays = dayStats
    .map(d => `${DAY_NAMES[parseInt(d.day_of_week)]}: ${d.count} messages`)
    .slice(0, 5);

  // If no OpenAI key, return basic stats
  if (!config.openaiApiKey) {
    return {
      group_name: groupName,
      group_id: groupId,
      top_topics: ['OpenAI API key not configured'],
      summary: `${totalCount} messages in the last 7 days. Configure OpenAI API key for topic analysis.`,
      most_active_days: mostActiveDays,
      total_messages: totalCount,
      unique_users: uniqueUsers,
      error: 'OpenAI API key not configured'
    };
  }

  // Prepare prompt for OpenAI
  const conversationText = messageTexts.join('\n---\n').substring(0, 15000); // Limit to ~15k chars

  const prompt = `Analyze the following conversations from the group "${groupName}" from the last week. Return ONLY valid JSON (no markdown, no comments):
{
  "top_topics": ["topic1", "topic2", ...],
  "summary": "brief summary of 2-3 sentences"
}

Rules:
- Maximum 8 main topics in top_topics
- Topics should be concise (2-4 words)
- The summary must be in English
- If there is not enough content, indicate it in the summary

Conversations:
${conversationText}`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that analyzes group conversations and returns JSON summaries. Always respond with valid JSON only, no markdown formatting.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.3,
      max_tokens: 500
    });

    const responseText = completion.choices[0].message.content.trim();

    // Parse JSON response (handle potential markdown wrapping)
    let jsonStr = responseText;
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '');
    }

    const analysis = JSON.parse(jsonStr);

    return {
      group_name: groupName,
      group_id: groupId,
      top_topics: analysis.top_topics || [],
      summary: analysis.summary || 'No summary available.',
      most_active_days: mostActiveDays,
      total_messages: totalCount,
      unique_users: uniqueUsers,
      error: null
    };
  } catch (error) {
    console.error(`[SUMMARY] Error analyzing group ${groupName}:`, error.message);
    return {
      group_name: groupName,
      group_id: groupId,
      top_topics: [],
      summary: `Error generating summary: ${error.message}`,
      most_active_days: mostActiveDays,
      total_messages: totalCount,
      unique_users: uniqueUsers,
      error: error.message
    };
  }
}

/**
 * Generate HTML dashboard from summaries
 * @param {Array} summaries - Array of group summaries
 * @param {string} outputPath - Output HTML file path
 */
function generateHtmlDashboard(summaries, outputPath) {
  const reportDate = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  const groupCards = summaries.map(s => `
    <div class="group-card">
      <h2>${escapeHtml(s.group_name)}</h2>
      <div class="stats">
        <span class="stat-item">
          <strong>${s.total_messages}</strong> messages
        </span>
      </div>

      <div class="section">
        <h3>Top Topics</h3>
        <div class="topics">
          ${s.top_topics.length > 0
            ? s.top_topics.map(t => `<span class="topic-tag">${escapeHtml(t)}</span>`).join('')
            : '<span class="no-data">No topics identified</span>'
          }
        </div>
      </div>

      <div class="section">
        <h3>Summary</h3>
        <p class="summary-text">${escapeHtml(s.summary)}</p>
      </div>

      <div class="section">
        <h3>Most Active Days</h3>
        <ul class="active-days">
          ${s.most_active_days.length > 0
            ? s.most_active_days.map(d => `<li>${escapeHtml(d)}</li>`).join('')
            : '<li class="no-data">No activity data</li>'
          }
        </ul>
      </div>

      ${s.error ? `<div class="error-note">Note: ${escapeHtml(s.error)}</div>` : ''}
    </div>
  `).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp Bot - Weekly Topic Summary</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
    }

    header {
      text-align: center;
      color: white;
      margin-bottom: 30px;
    }

    header h1 {
      font-size: 2.5rem;
      margin-bottom: 10px;
      text-shadow: 2px 2px 4px rgba(0,0,0,0.2);
    }

    header .date {
      font-size: 1rem;
      opacity: 0.9;
    }

    .groups-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
      gap: 20px;
    }

    .group-card {
      background: white;
      border-radius: 16px;
      padding: 24px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.15);
      transition: transform 0.2s ease;
    }

    .group-card:hover {
      transform: translateY(-5px);
    }

    .group-card h2 {
      color: #333;
      font-size: 1.4rem;
      margin-bottom: 15px;
      padding-bottom: 10px;
      border-bottom: 2px solid #667eea;
    }

    .stats {
      display: flex;
      gap: 15px;
      margin-bottom: 20px;
    }

    .stat-item {
      background: #f0f4ff;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 0.9rem;
      color: #667eea;
    }

    .section {
      margin-bottom: 20px;
    }

    .section h3 {
      color: #555;
      font-size: 0.9rem;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 10px;
    }

    .topics {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .topic-tag {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 0.85rem;
      font-weight: 500;
    }

    .summary-text {
      color: #444;
      line-height: 1.6;
      font-size: 0.95rem;
    }

    .active-days {
      list-style: none;
    }

    .active-days li {
      padding: 6px 0;
      color: #555;
      border-bottom: 1px solid #eee;
      font-size: 0.9rem;
    }

    .active-days li:last-child {
      border-bottom: none;
    }

    .no-data {
      color: #999;
      font-style: italic;
    }

    .error-note {
      margin-top: 15px;
      padding: 10px;
      background: #fff3cd;
      border-radius: 8px;
      color: #856404;
      font-size: 0.85rem;
    }

    footer {
      text-align: center;
      color: white;
      margin-top: 30px;
      opacity: 0.8;
      font-size: 0.9rem;
    }

    @media (max-width: 768px) {
      header h1 {
        font-size: 1.8rem;
      }

      .groups-grid {
        grid-template-columns: 1fr;
      }

      .group-card {
        padding: 18px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>WhatsApp Bot Groups</h1>
      <p class="subtitle">Weekly Topic Summary</p>
      <p class="date">Generated: ${reportDate}</p>
    </header>

    <div class="groups-grid">
      ${groupCards}
    </div>

    <footer>
      <p>WhatsApp Bot - Weekly Dashboard</p>
    </footer>
  </div>
</body>
</html>`;

  fs.writeFileSync(outputPath, html, 'utf8');
  console.log(`[SUMMARY] HTML dashboard saved to: ${outputPath}`);
}

/**
 * Escape HTML special characters
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Generate weekly dashboard for all monitored groups
 * @param {Object} sock - Baileys socket (for getting group names)
 * @param {Array<{name: string, id: string}>} monitoredGroups - Array of monitored groups with IDs
 * @returns {Promise<Object>} Result with summaries and file paths
 */
async function generateWeeklyDashboard(sock, monitoredGroups = null) {
  console.log('[SUMMARY] Starting weekly dashboard generation...');

  const summaries = [];

  // If monitoredGroups not provided, try to build from WhatsApp
  let groups = monitoredGroups;
  if (!groups || groups.length === 0) {
    groups = [];
    if (sock) {
      try {
        const allGroups = await sock.groupFetchAllParticipating();
        for (const groupName of config.groupsToMonitor) {
          const found = Object.entries(allGroups).find(
            ([id, g]) => g.subject.toLowerCase() === groupName.toLowerCase()
          );
          if (found) {
            groups.push({ name: found[1].subject, id: found[0] });
          } else {
            console.log(`[SUMMARY] Group "${groupName}" not found`);
          }
        }
      } catch (e) {
        console.error('[SUMMARY] Error fetching groups:', e.message);
      }
    }
  }

  for (const group of groups) {
    const summary = await generateGroupSummary(group.id, group.name);
    summaries.push(summary);
  }

  // Define output paths
  const dataDir = path.join(__dirname, '..', 'data');
  const publicDir = path.join(__dirname, '..', 'public');

  // Ensure directories exist
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }

  const jsonPath = path.join(dataDir, 'weekly_summary.json');
  const htmlPath = path.join(publicDir, 'dashboard.html');

  // Save JSON
  const jsonData = {
    generated_at: new Date().toISOString(),
    groups: summaries
  };
  fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2), 'utf8');
  console.log(`[SUMMARY] JSON saved to: ${jsonPath}`);

  // Generate HTML
  generateHtmlDashboard(summaries, htmlPath);

  return {
    success: true,
    summaries,
    jsonPath,
    htmlPath,
    dashboardUrl: 'http://localhost:3000/dashboard'
  };
}

module.exports = {
  generateGroupSummary,
  generateHtmlDashboard,
  generateWeeklyDashboard
};
