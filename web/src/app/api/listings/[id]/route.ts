import { NextRequest, NextResponse } from 'next/server';
import { getListing, getCostBreakdown, getAuditLog, getEmails, updateListing } from '@/lib/db';

export async function GET(
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

    const costBreakdown = getCostBreakdown(listingId);
    const auditLog = getAuditLog(listingId);
    const emails = getEmails(listingId);

    return NextResponse.json({
      listing,
      costBreakdown,
      auditLog,
      emails,
    });
  } catch (error) {
    console.error('Listing API error:', error);
    return NextResponse.json({ error: 'Failed to load listing' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const listingId = parseInt(id, 10);

    if (isNaN(listingId)) {
      return NextResponse.json({ error: 'Invalid listing ID' }, { status: 400 });
    }

    const body = await request.json();
    updateListing(listingId, body);

    const listing = getListing(listingId);
    return NextResponse.json({ listing });
  } catch (error) {
    console.error('Listing update error:', error);
    return NextResponse.json({ error: 'Failed to update listing' }, { status: 500 });
  }
}
