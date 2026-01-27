# Car Search Automation - Architecture Design

## Current Proposed Flows

### Flow 1: Initial Scouting (Script-based)
1. Gather full info from listing and links provided
2. For interesting listings, submit request through web form
3. Record listing info and contact attempt in DB
4. Calculate and store total cost

### Flow 2: Email Follow-up (Claude-powered)
1. Check email for replies to our requests
2. Save emails + attachments to workspace per listing
3. Launch Claude to analyze, investigate links, and reply

### Flow 3: Rank Winning Offers (Claude-powered)
1. Launch Claude over workspace to identify top 3 listings

---

## Architecture Analysis

### What's Good

- **Separation of concerns**: Script for data gathering, AI for decision-making
- **Workspace pattern**: Giving Claude full context via files is smart
- **Multi-listing leverage**: Using competing offers against each other

---

## What's Missing or Could Be Improved

### 1. No State Machine for Listings

Each listing should have a clear lifecycle state:

```
discovered → analyzed → contacted → awaiting_response → negotiating →
viewing_scheduled → inspected → offer_accepted → purchased
                                              ↘ rejected/withdrawn
```

Right now status is loose. A proper state machine would:
- Prevent invalid transitions (can't make offer before CARFAX)
- Enable time-based triggers (no response in 3 days → follow up)
- Track where each deal actually is

### 2. No Human-in-the-Loop Checkpoints

The system should STOP and ask at critical moments:
- Before sending any offer over $X
- Before scheduling a viewing
- When unusual seller behavior detected
- When budget threshold approached
- Final purchase decision

Currently it's either fully manual or fully auto - needs a middle ground.

### 3. No Deal Readiness Score

Each listing should have a "ready to buy" checklist score:

```
[ ] CARFAX received and clean
[ ] Price negotiated below market
[ ] All questions answered
[ ] Seller responsive
[ ] Within budget (with all fees)
[ ] No red flags
→ Readiness: 4/6 (67%)
```

This makes ranking trivial - just sort by readiness + value.

### 4. Missing Timeline/Urgency Tracking

- How long since we contacted each seller?
- How long since their last response?
- Is the listing still active? (Could be sold)
- Auto follow-up after X days of silence?
- Auto-deprioritize unresponsive sellers?

### 5. No Viewing/Inspection Flow

The pipeline assumes all negotiation is remote. Eventually you need to:
- Schedule a viewing
- Do a test drive
- Get mechanic inspection
- Make final decision in person

This is the actual "final step for human" - but we're not tracking it.

### 6. No Portfolio View of Active Negotiations

You're negotiating multiple cars simultaneously. Need to track:
- Total potential spend across all deals
- Best current price per listing
- Time invested per negotiation
- Which to prioritize vs abandon

### 7. No Seller Intelligence

Track per-seller:
- Response time patterns
- Negotiation flexibility (firm vs willing to deal)
- Trustworthiness signals
- Communication style

This informs negotiation strategy.

### 8. Missing Risk Verification

Beyond CARFAX:
- VIN recall check
- Market value comparison (Canadian Black Book)
- Dealer reviews (if dealership)
- Insurance quote estimate
- Common problems for this model/year

### 9. No Audit Trail

Every automated action should log:
- What was done
- Why (reasoning)
- What context Claude had
- Timestamp

For debugging and trust.

---

## Proposed Improved Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         DISCOVERY LAYER                              │
│  (Script-based, no AI)                                              │
│                                                                      │
│  • Scrape listings (full description, specs, CARFAX link)           │
│  • Calculate total cost                                              │
│  • Initial filtering (budget, distance, year)                        │
│  • Store in DB with state = "discovered"                            │
└─────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────┐
│                         TRIAGE LAYER                                 │
│  (Quick AI pass or rules-based)                                     │
│                                                                      │
│  • Score each listing (value, risk, fit)                            │
│  • Mark as "interesting" or "skip"                                  │
│  • Prioritize which to contact first                                │
└─────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────┐
│                         OUTREACH LAYER                               │
│  (Script-based)                                                      │
│                                                                      │
│  • Submit web forms for interesting listings                        │
│  • Fetch CARFAX if link available                                   │
│  • State → "contacted"                                              │
└─────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────┐
│                      NEGOTIATION LAYER                               │
│  (Claude AI with full context)                                      │
│                                                                      │
│  • Process incoming emails                                          │
│  • Analyze CARFAX reports                                           │
│  • Follow links in emails                                           │
│  • Draft responses (negotiate, request info, schedule viewing)      │
│  • Update deal readiness score                                      │
│  • CHECKPOINT: Human approval for offers > $X                       │
└─────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────┐
│                       PORTFOLIO LAYER                                │
│  (Claude AI with cross-listing context)                             │
│                                                                      │
│  • Track all active negotiations                                    │
│  • Identify top candidates by readiness score                       │
│  • Recommend which to pursue vs abandon                             │
│  • Schedule viewings for top picks                                  │
│  • CHECKPOINT: Human decision on viewing schedule                   │
└─────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────┐
│                        CLOSING LAYER                                 │
│  (Human with AI support)                                            │
│                                                                      │
│  • View car in person                                               │
│  • Mechanic inspection                                              │
│  • Final negotiation (AI can suggest tactics)                       │
│  • HUMAN DECISION: Purchase or walk away                            │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Key Design Principles

### 1. Script for Data, AI for Decisions
Don't use AI for web scraping or form filling. Do use AI for strategy, analysis, and communication.

### 2. Checkpoints, Not Full Automation
The human should approve at key moments, not micromanage every step. Define clear thresholds.

### 3. State Machine Discipline
Every listing has a clear state. Transitions are explicit and logged. Invalid transitions are prevented.

### 4. Portfolio Thinking
Manage all negotiations as a portfolio, not individually. Track total exposure, opportunity cost, time investment.

### 5. Time-Aware Operations
Track how long things take. Auto-escalate stale negotiations. Follow up on unresponsive sellers. Deprioritize dead leads.

### 6. Full Auditability
Log everything so you can understand what happened and why. Every AI decision should have recorded reasoning.

---

## Recommended Additional Tasks

Based on this analysis, consider adding:

| Task | Priority | Description |
|------|----------|-------------|
| Implement listing state machine | High | Foundation for everything else |
| Add human approval checkpoints | High | Configurable thresholds for offers, viewings |
| Create deal readiness score | High | Makes ranking trivial |
| Add timeline tracking | Medium | contacted_at, last_response_at, follow_up_due |
| Create portfolio dashboard | Medium | Overview of all active negotiations |
| Seller intelligence tracking | Low | Response patterns, flexibility |
| Risk verification integrations | Low | Recall checks, market value, reviews |

---

## Data Model Enhancements

### Listing State Machine

```typescript
type ListingState =
  | 'discovered'      // Found in search
  | 'analyzed'        // AI analysis complete
  | 'contacted'       // Initial outreach sent
  | 'awaiting_response' // Waiting for dealer
  | 'negotiating'     // Active back-and-forth
  | 'viewing_scheduled' // Viewing booked
  | 'inspected'       // Seen in person
  | 'offer_made'      // Formal offer submitted
  | 'purchased'       // Deal closed
  | 'rejected'        // We walked away
  | 'withdrawn'       // Seller withdrew / sold to someone else
```

### Timeline Tracking

```typescript
interface ListingTimeline {
  discovered_at: Date;
  contacted_at: Date | null;
  first_response_at: Date | null;
  last_seller_response_at: Date | null;
  last_our_response_at: Date | null;
  carfax_received_at: Date | null;
  viewing_scheduled_for: Date | null;
  follow_up_due_at: Date | null;
}
```

### Deal Readiness Score

```typescript
interface ReadinessScore {
  carfax_received: boolean;       // +20 points
  carfax_clean: boolean;          // +15 points
  price_negotiated: boolean;      // +15 points
  within_budget: boolean;         // +20 points
  seller_responsive: boolean;     // +10 points
  no_red_flags: boolean;          // +20 points
  total_score: number;            // 0-100
}
```

### Cost Breakdown

```json
{
  "listing_id": 1,
  "asking_price": 12995,
  "negotiated_price": null,
  "estimated_price": 12000,
  "fees": {
    "admin_fee": 499,
    "documentation_fee": 0,
    "certification_fee": 0,
    "other_fees": 0
  },
  "taxes": {
    "hst_rate": 0.13,
    "hst_amount": 1625,
    "other_taxes": 0
  },
  "registration": {
    "included": false,
    "estimated_cost": 150
  },
  "total_estimated_cost": 14274,
  "budget": 18000,
  "remaining_after_purchase": 3726,
  "within_budget": true
}
```

---

## Human Checkpoints Configuration

```yaml
checkpoints:
  # Require approval before sending offers above this amount
  offer_approval_threshold: 10000

  # Require approval before scheduling any viewing
  viewing_requires_approval: true

  # Alert when total potential spend across all deals exceeds budget
  portfolio_exposure_alert: 18000

  # Alert when negotiation stalls for this many days
  stale_negotiation_days: 3

  # Auto-send follow-up after this many days without response
  auto_followup_days: 2

  # Max automated follow-ups before requiring human decision
  max_auto_followups: 2
```

---

## Questions to Resolve

1. **What's the budget?** Need a clear number for all cost calculations.

2. **Geographic constraints?** Max distance willing to travel for viewing?

3. **Timeline pressure?** Need car by a certain date? This affects negotiation strategy.

4. **Financing vs cash?** Affects total cost and negotiation leverage.

5. **Trade-in?** If trading in a vehicle, that changes the calculus.

6. **Must-have features?** Stow'n'go? Backup camera? Nav? This affects filtering.

7. **Deal-breakers?** Max mileage? Max accidents? These should be hard filters.
