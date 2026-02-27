# WhatsApp Bot - Group Moderation & Management

A WhatsApp bot built with [Baileys](https://github.com/WhiskeySockets/Baileys) for group moderation, content filtering, user verification, and weekly analytics.

## Features

### Content Moderation
The bot automatically detects and removes messages containing:

**Spam Detection:**
- Excessive links (more than 3 links)
- Excessive capital letters (more than 70% caps)
- Repeated messages (same message 3+ times in 1 minute)

**Sensitive Topics (Text & Images):**
- Politics / politicians / parties / elections
- Religion / religious figures / practices / conversions
- Castes / reservation system / caste-based content
- Gender wars / feminism vs. men's rights
- LGBTQ+ topics / transgender rights / same-sex marriage
- Racism / skin color / regionalism / ethnic stereotypes
- Vaccines / COVID / 5G / conspiracy theories
- Abortion / pro-life vs. pro-choice

**Toxic Content:**
- Uses OpenAI Moderation API to detect hate speech, harassment, violence, etc.

**Image Analysis:**
- Uses OpenAI Vision API to analyze images for sensitive content
- Saves a brief description of flagged images in the moderation log

### User Verification
- New members joining monitored groups receive a verification challenge
- Users must solve a simple math question to verify they are human
- Unverified users are automatically removed after the timeout period

### Admin Exemption
- Group administrators are exempt from moderation
- The bot validates that your configured admin is a group admin on startup

### Web Dashboard
Access the bot console at `http://localhost:3000` to:
- View connection status
- See monitored groups and their status
- Generate weekly summaries
- View deleted messages with restore option

### Weekly Summary
- Analyzes messages from the last 7 days using OpenAI
- Generates topic summaries for each monitored group
- Shows message count and unique users per group

### Message Restoration
- Deleted messages are logged with full details
- Administrators can restore messages from the dashboard
- Restored messages are resent to the group with attribution

## Installation

### Prerequisites
- Node.js 18 or higher
- npm or yarn
- OpenAI API key

### Setup

1. **Clone the repository:**
```bash
git clone https://github.com/yourusername/whatsapp-bot.git
cd whatsapp-bot
```

2. **Install dependencies:**
```bash
npm install --legacy-peer-deps
```

3. **Create configuration file:**
```bash
cp config.example.json config.json
```

4. **Edit `config.json` with your settings:**
```json
{
  "admins": ["your-phone-number"],
  "groupsToMonitor": [
    "Exact Name of WhatsApp Group 1",
    "Exact Name of WhatsApp Group 2"
  ],
  "verificationTimeoutMinutes": 5,
  "openaiApiKey": "sk-proj-your-openai-api-key"
}
```

5. **Start the bot:**
```bash
npm start
```

6. **Scan the QR code** displayed in the terminal with WhatsApp

## Configuration

| Field | Description |
|-------|-------------|
| `admins` | Array of phone numbers (without + or spaces) that receive admin privileges |
| `groupsToMonitor` | Array of exact WhatsApp group names to moderate |
| `verificationTimeoutMinutes` | Time in minutes before unverified users are removed |
| `openaiApiKey` | Your OpenAI API key for content moderation and summaries |

### Important Notes:
- Phone numbers should be in format: `1234567890` (country code + number, no symbols)
- Group names must match exactly (case-insensitive)
- The first admin in the list should be an admin of all monitored groups
- The bot must be added as a member of the groups to monitor them

## Usage

### Web Dashboard

Access `http://localhost:3000` after starting the bot.

**Status Bar:**
- Shows connection status (green = connected, red = disconnected)
- Displays bot's WhatsApp number

**Monitored Groups:**
- Green indicator = group found and being monitored
- Red indicator = group not found (check the name)

**Buttons:**
- **Weekly Summary**: Generate AI-powered topic analysis
- **Deleted Messages**: View moderation log with restore option

### Moderation Flow

1. User sends a message in a monitored group
2. Bot checks if sender is a group admin (admins are exempt)
3. Bot analyzes text for spam, sensitive topics, and toxic content
4. If image is present, analyzes with OpenAI Vision
5. If violation found:
   - Message is deleted
   - User receives private notification explaining why
   - Log entry is created in dashboard

### User Notifications

When a message is deleted, the user receives a private message:
```
⚠️ Your message was deleted

Group: [Group Name]
Reason: Your message [reason description].

Please follow the group rules to maintain a pleasant environment for everyone.

If you believe this was an error, please contact an administrator.
```

## Project Structure

```
├── index.js              # Main bot application
├── db.js                 # Database operations (SQLite)
├── moderation.js         # Content moderation logic
├── verification.js       # User verification system
├── config.json           # Configuration (not in repo)
├── config.example.json   # Example configuration
├── public/
│   └── index.html        # Web dashboard
├── summary/
│   └── summary.js        # Weekly summary generation
└── data/                 # Generated data files
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/bot-status` | GET | Bot connection status and config |
| `/api/weeklysummary` | GET | Generate weekly summary |
| `/api/moderation-logs` | GET | Get deleted messages log |
| `/api/restore-message/:id` | POST | Restore a deleted message |
| `/api/clear-moderation-logs` | POST | Clear all moderation logs |
| `/api/groups` | GET | List all groups bot is member of |

## Dependencies

- **@whiskeysockets/baileys** - WhatsApp Web API
- **better-sqlite3** - SQLite database
- **openai** - OpenAI API client
- **express** - Web server
- **qrcode-terminal** - QR code display
- **pino** - Logging

## Troubleshooting

### "Group not found" warning
- Ensure the group name in `config.json` matches exactly
- Make sure the bot is a member of the group
- Group names are case-insensitive

### Bot can't delete messages
- The bot must be an admin of the group
- Or the first admin in config must be a group admin

### OpenAI errors
- Verify your API key is valid
- Check your OpenAI account has credits
- Ensure you have access to GPT-4o-mini and Vision API

### Authentication issues
- Delete the `auth_info` folder and restart
- Scan the new QR code

## License

MIT License - See LICENSE file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## Disclaimer

This bot is intended for legitimate group management purposes. Users are responsible for:
- Complying with WhatsApp's Terms of Service
- Ensuring proper consent from group members
- Following local privacy laws and regulations

Use responsibly.
