import { NextRequest, NextResponse } from 'next/server';
import { getListings, getListingCount } from '@/lib/db';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;

    const status = searchParams.get('status');
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);
    const sortBy = searchParams.get('sortBy') || 'discoveredAt';
    const sortOrder = (searchParams.get('sortOrder') || 'desc') as 'asc' | 'desc';

    const statusArray = status ? status.split(',') : undefined;

    const listings = getListings({
      status: statusArray,
      limit,
      offset,
      sortBy,
      sortOrder,
    });

    const total = getListingCount(statusArray);

    return NextResponse.json({
      listings,
      total,
      limit,
      offset,
    });
  } catch (error) {
    console.error('Listings API error:', error);
    return NextResponse.json({ error: 'Failed to load listings' }, { status: 500 });
  }
}
