import { NextRequest, NextResponse } from 'next/server';
import { getListing, updateListing, addAuditEntry } from '@/lib/db';
import { createJob, runJob } from '@/lib/jobs';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const listingId = parseInt(id, 10);

    if (isNaN(listingId)) {
      return NextResponse.json({ error: 'Invalid listing ID' }, { status: 400 });
    }

    const listing = getListing(listingId);
    if (!listing) {
      return NextResponse.json({ error: 'Listing not found' }, { status: 404 });
    }

    const body = await request.json();
    const { action, notes } = body;

    switch (action) {
      case 'mark-interesting': {
        const prevStatus = listing.status;
        // Use 'analyzed' status for interesting listings (matches triage command behavior)
        // Also add a note to indicate this was marked as interesting
        const interestingNote = notes ? `[INTERESTING] ${notes}` : '[INTERESTING] Marked via web UI';
        updateListing(listingId, { status: 'analyzed', notes: interestingNote });
        addAuditEntry(listingId, 'status_change', prevStatus, 'analyzed', 'Marked as interesting via web UI');
        return NextResponse.json({ success: true, status: 'analyzed' });
      }

      case 'mark-skip': {
        const prevStatus = listing.status;
        updateListing(listingId, { status: 'rejected', notes });
        addAuditEntry(listingId, 'status_change', prevStatus, 'rejected', notes || 'Skipped via web UI');
        return NextResponse.json({ success: true, status: 'rejected' });
      }

      case 'analyze': {
        const job = createJob('analyze', [String(listingId)]);
        runJob(job);
        return NextResponse.json({ success: true, job });
      }

      case 'contact': {
        const job = createJob('contact', [String(listingId)]);
        runJob(job);
        return NextResponse.json({ success: true, job });
      }

      case 'calculate-cost': {
        const job = createJob('cost', [String(listingId)]);
        runJob(job);
        return NextResponse.json({ success: true, job });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (error) {
    console.error('Listing action error:', error);
    return NextResponse.json({ error: 'Failed to perform action' }, { status: 500 });
  }
}
