# CarSearch

Agentic used car search automation. Find your next vehicle without the tedious manual searching.

## Features

- **Automated Discovery**: Scrape CarGurus (more sites coming) for vehicles matching your criteria
- **Smart Tracking**: SQLite database tracks all candidates, status, and price changes
- **AI Analysis**: Claude-powered analysis of listings and CARFAX reports
- **Email Automation**: Semi-automated dealer communication (coming soon)
- **Privacy First**: All personal data stays local and is never committed

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
# Edit .env with your API keys

# Run a search
npm run search

# List results
npm run list
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
```

### .env

```
ANTHROPIC_API_KEY=sk-ant-xxxxx
EMAIL_USER=your-car-search@gmail.com
EMAIL_PASSWORD=your-app-password
```

## CLI Commands

```bash
# Search for vehicles
npm run dev search
npm run dev search --source cargurus
npm run dev search --dry-run

# List discovered vehicles
npm run dev list
npm run dev list --status new
npm run dev list --order price
npm run dev list --limit 50

# Show details for a listing
npm run dev show 1

# View statistics
npm run dev stats
```

## Project Structure

```
├── src/
│   ├── cli/              # Command-line interface
│   ├── scrapers/         # Site scrapers (Playwright)
│   ├── analyzers/        # AI analysis modules
│   ├── email/            # IMAP/SMTP email handling
│   ├── database/         # SQLite with better-sqlite3
│   └── ranking/          # Scoring algorithms
├── config/
│   ├── config.example.yaml  # Template (committed)
│   └── config.local.yaml    # Your config (gitignored)
├── data/                 # Scraped data (gitignored)
└── neversplitthedifference.pdf  # Negotiation reference
```

## Privacy

The following are **never committed** to git:
- `config/config.local.yaml` - Your personal search criteria
- `.env` - API keys and email credentials
- `data/` - All scraped listings, CARFAX reports, photos
- `*.db` - SQLite database

## Roadmap

- [x] Phase 1: Core discovery (CarGurus scraper, SQLite, CLI)
- [ ] Phase 2: AI analysis pipeline
- [ ] Phase 3: Email automation
- [ ] Phase 4: Full agentic workflow
- [ ] AutoTrader.ca scraper
- [ ] Kijiji Autos scraper

## License

MIT
