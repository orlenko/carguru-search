# CarSearch

Fully automated used car search and negotiation system. Find, contact, and negotiate your next vehicle purchase without manual effort.

## Features

- **Automated Discovery**: Scrape AutoTrader and CarGurus for vehicles matching your criteria
- **AI Analysis**: Claude-powered analysis of listings detecting red flags, pricing issues, and deception
- **Smart Ranking**: Composite scoring based on price, mileage, condition, and AI assessment
- **Automated Outreach**: Contact dealers via web forms automatically
- **CARFAX Processing**: Auto-detect, save, and analyze CARFAX reports from email attachments
- **Price Negotiation**: AI-powered email negotiation with safety guardrails
- **Batch Workflow**: Triage and export candidates for deep analysis

## Quick Start

```bash
# Install dependencies
npm install

# Install Playwright browsers
npx playwright install chromium

# Copy and configure
cp config/config.example.yaml config/config.local.yaml
cp .env.example .env

# Edit config.local.yaml with your search criteria
# Edit .env with your API keys and email credentials

# Run the full automation pipeline
npm run dev -- pipeline
```

## Configuration

### config/config.local.yaml

```yaml
search:
  make: "Dodge"
  model: "Grand Caravan"
  yearMin: 2015
  yearMax: 2020
  mileageMax: 120000
  priceMax: 20000
  postalCode: "M5V1J1"
  radiusKm: 100

scoring:
  weights:
    price: 20
    mileage: 20
    condition: 20
    aiScore: 30
    distance: 10
  dealBreakers:
    - salvageTitle
    - frameDamage
    - floodDamage
```

### .env

```
ANTHROPIC_API_KEY=sk-ant-xxxxx
EMAIL_USER=your-car-search@gmail.com
EMAIL_PASSWORD=your-app-password
BUYER_NAME=Your Name
BUYER_PHONE=+1-555-0123

# Optional: For SMS/Voicemail features
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1-555-0000
```

## Automation Workflow

### Full Pipeline (One Command)

```bash
npm run dev -- pipeline
```

This runs all phases:
1. **Search**: Scrape AutoTrader for matching vehicles
2. **Analyze**: AI-analyze all new listings
3. **Outreach**: Contact top candidates via web forms
4. **Respond**: Process email responses, request/analyze CARFAX

### Daily Workflow

**Morning - Discovery (once per day):**
```bash
npm run dev -- pipeline                    # Full run
```

**Throughout the day - Monitoring (every few hours):**
```bash
npm run dev -- auto-respond                # Check emails, process CARFAX
npm run dev -- auto-negotiate              # Handle price negotiations
```

Or combined:
```bash
npm run dev -- pipeline --skip-search --skip-analyze --skip-outreach
```

### Cron Job Setup (Optional)

For true automation, add to crontab (`crontab -e`):

```bash
# Check for responses every 3 hours during business hours
0 9,12,15,18 * * * cd /path/to/carguru-search && npm run dev -- auto-respond >> logs/respond.log 2>&1
0 9,12,15,18 * * * cd /path/to/carguru-search && npm run dev -- auto-negotiate >> logs/negotiate.log 2>&1

# Full search once daily at 8am
0 8 * * * cd /path/to/carguru-search && npm run dev -- pipeline >> logs/pipeline.log 2>&1
```

### When Human Attention Is Needed

The system handles everything automatically **except**:
- Dealer accepts your offer → needs your confirmation
- Max negotiation exchanges reached → stalled, need judgment
- Scheduling a viewing → calendar coordination
- Final purchase decision

Check status:
```bash
npm run dev -- negotiation-status          # See deals needing attention
npm run dev -- inbox                       # See all active conversations
```

## CLI Commands

### Discovery
```bash
npm run dev -- search                      # Search AutoTrader
npm run dev -- search --source cargurus    # Search CarGurus
npm run dev -- list                        # List all discoveries
npm run dev -- list --status interesting   # Filter by status
npm run dev -- show <id>                   # View listing details
npm run dev -- stats                       # View statistics
```

### Analysis
```bash
npm run dev -- analyze all                 # AI-analyze all new listings
npm run dev -- analyze <id>                # Analyze specific listing
npm run dev -- rank                        # Show ranked candidates
npm run dev -- carfax <path>               # Analyze a CARFAX PDF
```

### Communication
```bash
npm run dev -- outreach --limit 5          # Contact top 5 candidates
npm run dev -- check-email                 # Check for responses
npm run dev -- auto-respond                # Auto-request CARFAX
npm run dev -- respond <id>                # Generate response to dealer
```

### Negotiation
```bash
npm run dev -- negotiate <id> --start      # Start price negotiation
npm run dev -- negotiate <id> --respond    # Respond to dealer
npm run dev -- negotiate <id> --auto-send  # Auto-send with safety limits
npm run dev -- auto-negotiate              # Process all negotiations
npm run dev -- negotiation-status          # View active negotiations
```

### Batch Workflow
```bash
npm run dev -- triage                      # Interactive review
npm run dev -- export                      # Export for Claude analysis
npm run dev -- pipeline                    # Run full automation
```

## Negotiation Safety Limits

Auto-negotiation includes safety guardrails:

```bash
npm run dev -- auto-negotiate --max-offer 15000 --max-exchanges 6
```

- `--max-offer`: Never exceed this amount (default: 95% of walk-away price)
- `--max-exchanges`: Stop after N exchanges (default: 6)

Auto-blocks and alerts you when:
- AI requests human attention
- Offer would exceed your limit
- Deal is near completion
- Negotiation has stalled

## Project Structure

```
├── src/
│   ├── cli/              # Command-line interface
│   │   └── commands/     # Individual commands
│   ├── scrapers/         # Site scrapers (Playwright)
│   ├── analyzers/        # AI analysis (listings, CARFAX)
│   ├── email/            # IMAP/SMTP + SMS handling
│   ├── database/         # SQLite with better-sqlite3
│   ├── ranking/          # Scoring algorithms
│   ├── negotiation/      # AI negotiation engine
│   ├── pricing/          # Cost calculation (taxes, fees)
│   └── contact/          # Web form automation
├── config/
│   ├── config.example.yaml
│   └── config.local.yaml    # Your config (gitignored)
├── data/                    # Attachments, CARFAX (gitignored)
├── export/                  # Batch exports for analysis
└── logs/                    # Automation logs
```

## Privacy

The following are **never committed** to git:
- `config/config.local.yaml` - Your personal search criteria
- `.env` - API keys and email credentials
- `data/` - CARFAX reports, attachments
- `export/` - Batch exports
- `*.db` - SQLite database
- `logs/` - Automation logs

## Status Workflow

Listings progress through these statuses:

```
new → interesting → contacted → carfax_requested → carfax_received → analyzed → shortlisted
                 ↘ rejected
```

## License

MIT
