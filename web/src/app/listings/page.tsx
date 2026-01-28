'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import StatusBadge from '@/components/StatusBadge';

interface Listing {
  id: number;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  price: number | null;
  mileageKm: number | null;
  status: string;
  city: string | null;
  province: string | null;
  readinessScore: number | null;
  score: number | null;
  sellerType: string | null;
  sourceUrl: string;
}

function formatCurrency(amount: number | null): string {
  if (amount === null) return '-';
  return `$${amount.toLocaleString()}`;
}

function formatMileage(km: number | null): string {
  if (km === null) return '-';
  return `${km.toLocaleString()} km`;
}

const statusOptions = [
  { value: '', label: 'All Statuses' },
  { value: 'discovered', label: 'Discovered' },
  { value: 'analyzed', label: 'Analyzed' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'awaiting_response', label: 'Awaiting Response' },
  { value: 'negotiating', label: 'Negotiating' },
  { value: 'viewing_scheduled', label: 'Viewing Scheduled' },
  { value: 'offer_made', label: 'Offer Made' },
  { value: 'rejected', label: 'Rejected' },
];

function ListingsContent() {
  const searchParams = useSearchParams();
  const [listings, setListings] = useState<Listing[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') || '');

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (statusFilter) params.set('status', statusFilter);
    params.set('limit', '100');

    fetch(`/api/listings?${params}`)
      .then(res => res.json())
      .then(data => {
        setListings(data.listings);
        setTotal(data.total);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [statusFilter]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Listings</h1>
        <div className="flex items-center gap-4">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {statusOptions.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="text-sm text-gray-500">
            {total} listing{total !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : listings.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No listings found</div>
        ) : (
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Vehicle
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Price
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Mileage
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Location
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Readiness
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {listings.map((listing) => (
                <tr key={listing.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <Link
                      href={`/listings/${listing.id}`}
                      className="text-blue-600 hover:text-blue-800 font-medium"
                    >
                      {listing.year} {listing.make} {listing.model}
                    </Link>
                    {listing.trim && (
                      <span className="text-gray-500 text-sm ml-1">{listing.trim}</span>
                    )}
                    <div className="text-xs text-gray-400">
                      {listing.sellerType === 'private' ? 'Private' : 'Dealer'}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-gray-900 font-medium">
                    {formatCurrency(listing.price)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-gray-600">
                    {formatMileage(listing.mileageKm)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-gray-600">
                    {listing.city && listing.province
                      ? `${listing.city}, ${listing.province}`
                      : listing.city || listing.province || '-'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <StatusBadge status={listing.status} />
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center">
                      <div className="w-12 bg-gray-200 rounded-full h-2 mr-2">
                        <div
                          className="bg-blue-600 h-2 rounded-full"
                          style={{ width: `${listing.readinessScore || 0}%` }}
                        />
                      </div>
                      <span className="text-xs text-gray-600">
                        {listing.readinessScore || 0}%
                      </span>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm">
                    <a
                      href={listing.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-gray-500 hover:text-gray-700"
                    >
                      View Original ↗
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default function ListingsPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-gray-500">Loading...</div>}>
      <ListingsContent />
    </Suspense>
  );
}
