import { NextResponse } from 'next/server';
import { getDashboardStats, getListings, getPendingApprovals } from '@/lib/db';

export async function GET() {
  try {
    const stats = getDashboardStats();

    // Get priority listings (active negotiations sorted by readiness)
    const priorityListings = getListings({
      status: ['contacted', 'awaiting_response', 'negotiating', 'viewing_scheduled', 'offer_made'],
      limit: 10,
      sortBy: 'readinessScore',
      sortOrder: 'desc',
    });

    // Get pending approvals count
    const pendingApprovals = getPendingApprovals();

    return NextResponse.json({
      stats,
      priorityListings,
      pendingApprovalsCount: pendingApprovals.length,
    });
  } catch (error) {
    console.error('Dashboard API error:', error);
    return NextResponse.json({ error: 'Failed to load dashboard' }, { status: 500 });
  }
}
