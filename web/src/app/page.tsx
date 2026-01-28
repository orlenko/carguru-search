'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import StatusBadge from '@/components/StatusBadge';

interface DashboardData {
  stats: {
    total: number;
    byStatus: Record<string, number>;
    totalExposure: number;
    needsFollowUp: number;
    highReadiness: number;
  };
  priorityListings: Array<{
    id: number;
    year: number;
    make: string;
    model: string;
    price: number | null;
    status: string;
    readinessScore: number | null;
    lastContactedAt: string | null;
  }>;
  pendingApprovalsCount: number;
}

function StatCard({ label, value, subtext, icon, href }: {
  label: string;
  value: string | number;
  subtext?: string;
  icon: string;
  href?: string;
}) {
  const content = (
    <div className="bg-white rounded-lg shadow p-6 hover:shadow-md transition-shadow">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-500">{label}</p>
          <p className="text-2xl font-bold text-gray-900">{value}</p>
          {subtext && <p className="text-sm text-gray-500">{subtext}</p>}
        </div>
        <span className="text-3xl">{icon}</span>
      </div>
    </div>
  );

  if (href) {
    return <Link href={href}>{content}</Link>;
  }
  return content;
}

function formatCurrency(amount: number | null): string {
  if (amount === null) return '-';
  return `$${amount.toLocaleString()}`;
}

function daysSince(date: string | null): string {
  if (!date) return '-';
  const days = Math.floor((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24));
  if (days === 0) return 'Today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/dashboard')
      .then(res => res.json())
      .then(data => {
        setData(data);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-lg text-gray-500">Loading dashboard...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <p className="text-red-800">Error loading dashboard: {error}</p>
      </div>
    );
  }

  const { stats, priorityListings, pendingApprovalsCount } = data;

  const activeCount = (stats.byStatus['contacted'] || 0) +
    (stats.byStatus['awaiting_response'] || 0) +
    (stats.byStatus['negotiating'] || 0) +
    (stats.byStatus['viewing_scheduled'] || 0) +
    (stats.byStatus['offer_made'] || 0);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Portfolio Dashboard</h1>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Total Listings"
          value={stats.total}
          icon="🚗"
          href="/listings"
        />
        <StatCard
          label="Active Negotiations"
          value={activeCount}
          icon="💬"
          href="/listings?status=contacted,awaiting_response,negotiating"
        />
        <StatCard
          label="Total Exposure"
          value={formatCurrency(stats.totalExposure)}
          subtext="In active deals"
          icon="💰"
        />
        <StatCard
          label="Pending Approvals"
          value={pendingApprovalsCount}
          icon="✅"
          href="/approvals"
        />
      </div>

      {/* Second Row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard
          label="Needs Follow-up"
          value={stats.needsFollowUp}
          subtext="No response 2+ days"
          icon="⏰"
        />
        <StatCard
          label="High Readiness"
          value={stats.highReadiness}
          subtext="80%+ ready to buy"
          icon="🎯"
        />
        <StatCard
          label="Discovered"
          value={stats.byStatus['discovered'] || 0}
          subtext="Awaiting analysis"
          icon="🔍"
          href="/listings?status=discovered"
        />
      </div>

      {/* Status Breakdown */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Status Breakdown</h2>
        <div className="flex flex-wrap gap-2">
          {Object.entries(stats.byStatus)
            .sort((a, b) => b[1] - a[1])
            .map(([status, count]) => (
              <Link
                key={status}
                href={`/listings?status=${status}`}
                className="flex items-center gap-2 px-3 py-2 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
              >
                <StatusBadge status={status} />
                <span className="font-medium">{count}</span>
              </Link>
            ))}
        </div>
      </div>

      {/* Priority Listings */}
      <div className="bg-white rounded-lg shadow">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Priority Listings</h2>
          <p className="text-sm text-gray-500">Active negotiations sorted by readiness</p>
        </div>
        <div className="overflow-x-auto">
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
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Readiness
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Last Activity
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {priorityListings.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-4 text-center text-gray-500">
                    No active negotiations
                  </td>
                </tr>
              ) : (
                priorityListings.map((listing) => (
                  <tr key={listing.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <Link
                        href={`/listings/${listing.id}`}
                        className="text-blue-600 hover:text-blue-800 font-medium"
                      >
                        {listing.year} {listing.make} {listing.model}
                      </Link>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-gray-900">
                      {formatCurrency(listing.price)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <StatusBadge status={listing.status} />
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <div className="w-16 bg-gray-200 rounded-full h-2 mr-2">
                          <div
                            className="bg-blue-600 h-2 rounded-full"
                            style={{ width: `${listing.readinessScore || 0}%` }}
                          />
                        </div>
                        <span className="text-sm text-gray-600">
                          {listing.readinessScore || 0}%
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {daysSince(listing.lastContactedAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {priorityListings.length > 0 && (
          <div className="px-6 py-4 border-t border-gray-200">
            <Link
              href="/listings?status=contacted,awaiting_response,negotiating,viewing_scheduled,offer_made"
              className="text-blue-600 hover:text-blue-800 text-sm font-medium"
            >
              View all active negotiations →
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
