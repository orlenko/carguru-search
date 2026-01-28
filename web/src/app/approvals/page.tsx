'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Approval {
  id: number;
  listingId: number | null;
  actionType: string;
  description: string;
  reasoning: string | null;
  payload: Record<string, unknown>;
  checkpointType: string | null;
  thresholdValue: string | null;
  createdAt: string;
  listing: {
    id: number;
    vehicle: string;
    price: number | null;
  } | null;
}

interface ApprovalStats {
  pending: number;
  approved: number;
  rejected: number;
  expired: number;
}

function formatDate(date: string): string {
  return new Date(date).toLocaleDateString('en-CA', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatCurrency(amount: number | null): string {
  if (amount === null) return '-';
  return `$${amount.toLocaleString()}`;
}

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [stats, setStats] = useState<ApprovalStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  const fetchApprovals = () => {
    fetch('/api/approvals')
      .then(res => res.json())
      .then(data => {
        setApprovals(data.approvals);
        setStats(data.stats);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(() => {
    fetchApprovals();
  }, []);

  const handleAction = async (id: number, action: 'approve' | 'reject') => {
    setActionLoading(id);
    try {
      const response = await fetch('/api/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      });

      if (response.ok) {
        fetchApprovals();
      }
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return <div className="p-8 text-center text-gray-500">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Pending Approvals</h1>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-yellow-50 rounded-lg p-4">
            <p className="text-sm text-yellow-600">Pending</p>
            <p className="text-2xl font-bold text-yellow-700">{stats.pending}</p>
          </div>
          <div className="bg-green-50 rounded-lg p-4">
            <p className="text-sm text-green-600">Approved</p>
            <p className="text-2xl font-bold text-green-700">{stats.approved}</p>
          </div>
          <div className="bg-red-50 rounded-lg p-4">
            <p className="text-sm text-red-600">Rejected</p>
            <p className="text-2xl font-bold text-red-700">{stats.rejected}</p>
          </div>
          <div className="bg-gray-50 rounded-lg p-4">
            <p className="text-sm text-gray-600">Expired</p>
            <p className="text-2xl font-bold text-gray-700">{stats.expired}</p>
          </div>
        </div>
      )}

      {/* Approvals List */}
      <div className="space-y-4">
        {approvals.length === 0 ? (
          <div className="bg-white rounded-lg shadow p-8 text-center">
            <p className="text-gray-500 text-lg">No pending approvals</p>
            <p className="text-gray-400 text-sm mt-2">
              Actions requiring approval will appear here
            </p>
          </div>
        ) : (
          approvals.map((approval) => (
            <div key={approval.id} className="bg-white rounded-lg shadow p-6">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="bg-yellow-100 text-yellow-800 text-xs font-medium px-2 py-1 rounded">
                      {approval.actionType.replace('_', ' ').toUpperCase()}
                    </span>
                    {approval.checkpointType && (
                      <span className="bg-gray-100 text-gray-600 text-xs px-2 py-1 rounded">
                        {approval.checkpointType}
                        {approval.thresholdValue && ` (${approval.thresholdValue})`}
                      </span>
                    )}
                  </div>

                  <p className="text-lg font-medium text-gray-900">{approval.description}</p>

                  {approval.listing && (
                    <Link
                      href={`/listings/${approval.listing.id}`}
                      className="text-blue-600 hover:underline text-sm mt-1 inline-block"
                    >
                      {approval.listing.vehicle} - {formatCurrency(approval.listing.price)}
                    </Link>
                  )}

                  {approval.reasoning && (
                    <p className="text-sm text-gray-600 mt-2">
                      <span className="font-medium">Reason:</span> {approval.reasoning}
                    </p>
                  )}

                  <p className="text-xs text-gray-400 mt-2">
                    Created: {formatDate(approval.createdAt)}
                  </p>

                  {/* Payload Preview */}
                  <details className="mt-3">
                    <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">
                      View payload
                    </summary>
                    <pre className="mt-2 text-xs bg-gray-50 p-2 rounded overflow-x-auto">
                      {JSON.stringify(approval.payload, null, 2)}
                    </pre>
                  </details>
                </div>

                <div className="flex gap-2 ml-4">
                  <button
                    onClick={() => handleAction(approval.id, 'approve')}
                    disabled={actionLoading === approval.id}
                    className="bg-green-600 text-white px-4 py-2 rounded-md hover:bg-green-700 transition-colors disabled:opacity-50"
                  >
                    {actionLoading === approval.id ? '...' : 'Approve'}
                  </button>
                  <button
                    onClick={() => handleAction(approval.id, 'reject')}
                    disabled={actionLoading === approval.id}
                    className="bg-red-600 text-white px-4 py-2 rounded-md hover:bg-red-700 transition-colors disabled:opacity-50"
                  >
                    {actionLoading === approval.id ? '...' : 'Reject'}
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
