# CarSearch Web UI

A Next.js-based web dashboard for the car search automation system.

## Running the Web UI

From the `web/` directory:

```bash
# Development mode (with hot reload)
npm run dev

# Production build
npm run build
npm start
```

The server runs on http://localhost:3000

## Pages

- **/** - Dashboard with portfolio overview, stats, and priority listings
- **/listings** - Browse all listings with status filtering
- **/listings/[id]** - Detailed view of a single listing (info, cost, emails, audit log)
- **/approvals** - Review and approve/reject pending automated actions

## Features

- Real-time stats on listing counts, total exposure, follow-up needs
- Status filtering on listings page
- Detailed listing view with tabs for different info types
- Cost breakdown display
- Email conversation history
- Audit trail viewer
- Approve/reject pending actions directly from the UI

## Database Connection

The web UI connects to the same SQLite database as the CLI (`data/carsearch.db`).
Make sure the database exists before starting the server.

## Tech Stack

- Next.js 16 with App Router
- React 19
- Tailwind CSS
- better-sqlite3 for database access
