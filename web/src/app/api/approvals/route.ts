import { NextRequest, NextResponse } from 'next/server';
import { getPendingApprovals, getApprovalStats, approveAction, rejectAction, getListing } from '@/lib/db';

export async function GET() {
  try {
    const approvals = getPendingApprovals();
    const stats = getApprovalStats();

    // Enrich with listing info
    const enrichedApprovals = approvals.map(approval => {
      const listing = approval.listingId ? getListing(approval.listingId) : null;
      return {
        ...approval,
        listing: listing ? {
          id: listing.id,
          vehicle: `${listing.year} ${listing.make} ${listing.model}`,
          price: listing.price,
        } : null,
      };
    });

    return NextResponse.json({
      approvals: enrichedApprovals,
      stats,
    });
  } catch (error) {
    console.error('Approvals API error:', error);
    return NextResponse.json({ error: 'Failed to load approvals' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, action, notes } = body;

    if (!id || !action) {
      return NextResponse.json({ error: 'Missing id or action' }, { status: 400 });
    }

    let result;
    if (action === 'approve') {
      result = approveAction(id, notes);
    } else if (action === 'reject') {
      result = rejectAction(id, notes);
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Approval action error:', error);
    return NextResponse.json({ error: 'Failed to process approval' }, { status: 500 });
  }
}
