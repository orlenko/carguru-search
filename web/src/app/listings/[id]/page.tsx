'use client';

import { useEffect, useState, use, useCallback } from 'react';
import Link from 'next/link';
import StatusBadge from '@/components/StatusBadge';

interface Job {
  id: string;
  command: string;
  status: 'running' | 'completed' | 'failed';
}

interface ListingDetail {
  listing: {
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
    postalCode: string | null;
    readinessScore: number | null;
    score: number | null;
    sellerType: string | null;
    sellerName: string | null;
    sellerPhone: string | null;
    sellerEmail: string | null;
    sourceUrl: string;
    source: string;
    vin: string | null;
    description: string | null;
    features: string[] | null;
    aiAnalysis: string | null;
    redFlags: string[] | null;
    carfaxReceived: boolean;
    carfaxSummary: string | null;
    accidentCount: number | null;
    ownerCount: number | null;
    notes: string | null;
    discoveredAt: string;
    contactedAt: string | null;
    analyzedAt: string | null;
  };
  costBreakdown: {
    askingPrice: number | null;
    negotiatedPrice: number | null;
    totalEstimatedCost: number | null;
    fees: Record<string, number> | null;
    taxAmount: number | null;
    budget: number | null;
    withinBudget: boolean | null;
  } | null;
  auditLog: Array<{
    id: number;
    action: string;
    fromState: string | null;
    toState: string | null;
    description: string | null;
    createdAt: string;
  }>;
  emails: Array<{
    id: number;
    direction: string;
    subject: string | null;
    body: string | null;
    createdAt: string;
  }>;
}

function formatCurrency(amount: number | null): string {
  if (amount === null) return '-';
  return `$${amount.toLocaleString()}`;
}

function formatDate(date: string | null): string {
  if (!date) return '-';
  return new Date(date).toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function ListingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<ListingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'info' | 'cost' | 'emails' | 'audit'>('info');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionJob, setActionJob] = useState<Job | null>(null);

  const fetchData = useCallback(() => {
    fetch(`/api/listings/${id}`)
      .then(res => res.json())
      .then(data => {
        setData(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Poll for job completion
  useEffect(() => {
    if (actionJob?.status === 'running') {
      const interval = setInterval(async () => {
        const res = await fetch(`/api/jobs?id=${actionJob.id}`);
        const jobData = await res.json();
        if (jobData.job) {
          setActionJob(jobData.job);
          if (jobData.job.status !== 'running') {
            setActionLoading(null);
            fetchData(); // Refresh listing data
          }
        }
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [actionJob, fetchData]);

  const runAction = async (action: string, notes?: string) => {
    setActionLoading(action);
    try {
      const res = await fetch(`/api/listings/${id}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, notes }),
      });
      const result = await res.json();
      if (result.job) {
        setActionJob(result.job);
      } else if (result.success) {
        fetchData();
        setActionLoading(null);
      } else if (result.error) {
        alert(result.error);
        setActionLoading(null);
      }
    } catch (error) {
      console.error('Action failed:', error);
      setActionLoading(null);
    }
  };

  if (loading) {
    return <div className="p-8 text-center text-gray-500">Loading...</div>;
  }

  if (!data || !data.listing) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <p className="text-red-800">Listing not found</p>
        <Link href="/listings" className="text-blue-600 hover:underline mt-2 inline-block">
          Back to listings
        </Link>
      </div>
    );
  }

  const { listing, costBreakdown, auditLog, emails } = data;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <Link href="/listings" className="text-sm text-gray-500 hover:text-gray-700 mb-2 inline-block">
            ← Back to listings
          </Link>
          <h1 className="text-2xl font-bold text-gray-900">
            {listing.year} {listing.make} {listing.model}
            {listing.trim && <span className="text-gray-500 font-normal ml-2">{listing.trim}</span>}
          </h1>
          <div className="flex items-center gap-4 mt-2">
            <StatusBadge status={listing.status} />
            <span className="text-2xl font-bold text-green-600">{formatCurrency(listing.price)}</span>
            {listing.mileageKm && (
              <span className="text-gray-500">{listing.mileageKm.toLocaleString()} km</span>
            )}
          </div>
        </div>
        <a
          href={listing.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700 transition-colors"
        >
          View on {listing.source} ↗
        </a>
      </div>

      {/* Readiness Score */}
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-gray-500">Readiness Score</h3>
            <p className="text-3xl font-bold text-gray-900">{listing.readinessScore || 0}%</p>
          </div>
          <div className="w-32 bg-gray-200 rounded-full h-4">
            <div
              className={`h-4 rounded-full ${
                (listing.readinessScore || 0) >= 80 ? 'bg-green-500' :
                (listing.readinessScore || 0) >= 50 ? 'bg-yellow-500' : 'bg-red-500'
              }`}
              style={{ width: `${listing.readinessScore || 0}%` }}
            />
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-sm font-medium text-gray-500 mb-3">Quick Actions</h3>
        <div className="flex flex-wrap gap-2">
          {!listing.analyzedAt && (
            <button
              onClick={() => runAction('analyze')}
              disabled={actionLoading !== null}
              className="bg-purple-600 text-white px-3 py-2 rounded-md text-sm hover:bg-purple-700 disabled:opacity-50 flex items-center gap-1"
            >
              {actionLoading === 'analyze' ? '⏳' : '🧠'} Analyze
            </button>
          )}
          {!listing.contactedAt && listing.analyzedAt && (
            <button
              onClick={() => runAction('contact')}
              disabled={actionLoading !== null}
              className="bg-green-600 text-white px-3 py-2 rounded-md text-sm hover:bg-green-700 disabled:opacity-50 flex items-center gap-1"
            >
              {actionLoading === 'contact' ? '⏳' : '📧'} Contact Seller
            </button>
          )}
          {!costBreakdown && (
            <button
              onClick={() => runAction('calculate-cost')}
              disabled={actionLoading !== null}
              className="bg-blue-600 text-white px-3 py-2 rounded-md text-sm hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1"
            >
              {actionLoading === 'calculate-cost' ? '⏳' : '💰'} Calculate Cost
            </button>
          )}
          {listing.status === 'discovered' && (
            <>
              <button
                onClick={() => runAction('mark-interesting')}
                disabled={actionLoading !== null}
                className="bg-yellow-500 text-white px-3 py-2 rounded-md text-sm hover:bg-yellow-600 disabled:opacity-50 flex items-center gap-1"
              >
                {actionLoading === 'mark-interesting' ? '⏳' : '⭐'} Mark Interesting
              </button>
              <button
                onClick={() => {
                  const reason = prompt('Skip reason (optional):');
                  if (reason !== null) runAction('mark-skip', reason);
                }}
                disabled={actionLoading !== null}
                className="bg-gray-500 text-white px-3 py-2 rounded-md text-sm hover:bg-gray-600 disabled:opacity-50 flex items-center gap-1"
              >
                {actionLoading === 'mark-skip' ? '⏳' : '⏭️'} Skip
              </button>
            </>
          )}
        </div>
        {actionJob && actionJob.status === 'running' && (
          <div className="mt-3 text-sm text-blue-600 animate-pulse">
            Running {actionJob.command}...
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex space-x-8">
          {(['info', 'cost', 'emails', 'audit'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`py-2 px-1 border-b-2 font-medium text-sm transition-colors ${
                activeTab === tab
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab === 'info' && 'Info'}
              {tab === 'cost' && 'Cost Breakdown'}
              {tab === 'emails' && `Emails (${emails.length})`}
              {tab === 'audit' && `Audit Log (${auditLog.length})`}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      <div className="bg-white rounded-lg shadow">
        {activeTab === 'info' && (
          <div className="p-6 space-y-6">
            {/* Quick Info */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p className="text-sm font-medium text-gray-600">VIN</p>
                <p className="font-semibold text-gray-900">{listing.vin || '-'}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-600">Location</p>
                <p className="font-semibold text-gray-900">
                  {listing.city && listing.province ? `${listing.city}, ${listing.province}` : '-'}
                </p>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-600">Seller Type</p>
                <p className="font-semibold text-gray-900 capitalize">{listing.sellerType || '-'}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-600">Seller Name</p>
                <p className="font-semibold text-gray-900">{listing.sellerName || '-'}</p>
              </div>
            </div>

            {/* Contact Info */}
            {(listing.sellerPhone || listing.sellerEmail) && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <h3 className="font-semibold text-blue-900 mb-2">Contact</h3>
                <div className="flex gap-4">
                  {listing.sellerPhone && (
                    <a href={`tel:${listing.sellerPhone}`} className="text-blue-700 hover:text-blue-900 font-medium hover:underline">
                      📞 {listing.sellerPhone}
                    </a>
                  )}
                  {listing.sellerEmail && (
                    <a href={`mailto:${listing.sellerEmail}`} className="text-blue-700 hover:text-blue-900 font-medium hover:underline">
                      ✉️ {listing.sellerEmail}
                    </a>
                  )}
                </div>
              </div>
            )}

            {/* CARFAX */}
            {listing.carfaxReceived && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <h3 className="font-medium text-green-800 mb-2">CARFAX Received</h3>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-green-600">Accidents:</span>{' '}
                    <span className="font-medium">{listing.accidentCount ?? 'Unknown'}</span>
                  </div>
                  <div>
                    <span className="text-green-600">Owners:</span>{' '}
                    <span className="font-medium">{listing.ownerCount ?? 'Unknown'}</span>
                  </div>
                </div>
                {listing.carfaxSummary && (
                  <p className="mt-2 text-sm text-green-700">{listing.carfaxSummary}</p>
                )}
              </div>
            )}

            {/* Red Flags */}
            {listing.redFlags && listing.redFlags.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <h3 className="font-medium text-red-800 mb-2">Red Flags</h3>
                <ul className="list-disc list-inside text-sm text-red-700">
                  {listing.redFlags.map((flag, i) => (
                    <li key={i}>{flag}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Description */}
            {listing.description && (
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">Description</h3>
                <p className="text-gray-800 whitespace-pre-wrap">{listing.description}</p>
              </div>
            )}

            {/* AI Analysis */}
            {listing.aiAnalysis && (
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">AI Analysis</h3>
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-gray-800 whitespace-pre-wrap">
                  {listing.aiAnalysis}
                </div>
              </div>
            )}

            {/* Timestamps */}
            <div className="text-sm text-gray-700 space-y-1 bg-gray-100 rounded-lg p-3">
              <p><span className="font-medium">Discovered:</span> {formatDate(listing.discoveredAt)}</p>
              {listing.analyzedAt && <p><span className="font-medium">Analyzed:</span> {formatDate(listing.analyzedAt)}</p>}
              {listing.contactedAt && <p><span className="font-medium">Contacted:</span> {formatDate(listing.contactedAt)}</p>}
            </div>
          </div>
        )}

        {activeTab === 'cost' && (
          <div className="p-6">
            {costBreakdown ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm font-medium text-gray-700">Asking Price</p>
                    <p className="text-2xl font-bold text-gray-900">{formatCurrency(costBreakdown.askingPrice)}</p>
                  </div>
                  {costBreakdown.negotiatedPrice && (
                    <div>
                      <p className="text-sm font-medium text-gray-700">Negotiated Price</p>
                      <p className="text-2xl font-bold text-green-700">
                        {formatCurrency(costBreakdown.negotiatedPrice)}
                      </p>
                    </div>
                  )}
                </div>

                {costBreakdown.fees && Object.keys(costBreakdown.fees).length > 0 && (
                  <div>
                    <p className="text-sm font-medium text-gray-700 mb-2">Fees</p>
                    <div className="bg-gray-100 rounded-lg p-4 space-y-2">
                      {Object.entries(costBreakdown.fees).map(([key, value]) => (
                        <div key={key} className="flex justify-between text-sm">
                          <span className="text-gray-800 capitalize">{key.replace(/([A-Z])/g, ' $1')}</span>
                          <span className="font-semibold text-gray-900">{formatCurrency(value)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {costBreakdown.taxAmount && (
                  <div className="flex justify-between py-2">
                    <span className="text-gray-800 font-medium">Tax (HST)</span>
                    <span className="font-semibold text-gray-900">{formatCurrency(costBreakdown.taxAmount)}</span>
                  </div>
                )}

                <div className="border-t-2 border-gray-200 pt-4">
                  <div className="flex justify-between text-lg">
                    <span className="font-semibold text-gray-900">Total Estimated Cost</span>
                    <span className="font-bold text-gray-900 text-xl">{formatCurrency(costBreakdown.totalEstimatedCost)}</span>
                  </div>
                </div>

                {costBreakdown.budget && (
                  <div className={`p-4 rounded-lg ${costBreakdown.withinBudget ? 'bg-green-100 border border-green-300' : 'bg-red-100 border border-red-300'}`}>
                    <div className="flex justify-between">
                      <span className={costBreakdown.withinBudget ? 'text-green-800 font-medium' : 'text-red-800 font-medium'}>Budget</span>
                      <span className={`font-semibold ${costBreakdown.withinBudget ? 'text-green-900' : 'text-red-900'}`}>{formatCurrency(costBreakdown.budget)}</span>
                    </div>
                    <div className="flex justify-between mt-2">
                      <span className={costBreakdown.withinBudget ? 'text-green-800 font-medium' : 'text-red-800 font-medium'}>{costBreakdown.withinBudget ? 'Within Budget' : 'Over Budget'}</span>
                      <span className={`font-bold text-lg ${costBreakdown.withinBudget ? 'text-green-700' : 'text-red-700'}`}>
                        {costBreakdown.withinBudget ? '✓' : '✗'}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-gray-700">No cost breakdown available. Run <code className="bg-gray-100 px-2 py-1 rounded">carsearch cost {id}</code> to calculate.</p>
            )}
          </div>
        )}

        {activeTab === 'emails' && (
          <div className="divide-y divide-gray-200">
            {emails.length === 0 ? (
              <p className="p-6 text-gray-600">No emails recorded</p>
            ) : (
              emails.map((email) => (
                <div key={email.id} className="p-6">
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`text-xs font-medium px-2 py-1 rounded ${
                      email.direction === 'outbound'
                        ? 'bg-blue-100 text-blue-800'
                        : 'bg-green-100 text-green-800'
                    }`}>
                      {email.direction === 'outbound' ? '→ Sent' : '← Received'}
                    </span>
                    <span className="text-sm text-gray-700">{formatDate(email.createdAt)}</span>
                  </div>
                  {email.subject && (
                    <p className="font-semibold text-gray-900 mb-1">{email.subject}</p>
                  )}
                  {email.body && (
                    <p className="text-sm text-gray-800 whitespace-pre-wrap">{email.body}</p>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === 'audit' && (
          <div className="divide-y divide-gray-200">
            {auditLog.length === 0 ? (
              <p className="p-6 text-gray-600">No audit entries</p>
            ) : (
              auditLog.map((entry) => (
                <div key={entry.id} className="p-4 hover:bg-gray-50">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-gray-900 bg-gray-100 px-2 py-1 rounded">{entry.action}</span>
                    {entry.fromState && entry.toState && (
                      <span className="text-sm text-gray-700 font-medium">
                        {entry.fromState} → {entry.toState}
                      </span>
                    )}
                  </div>
                  {entry.description && (
                    <p className="text-sm text-gray-800 mt-2">{entry.description}</p>
                  )}
                  <p className="text-xs text-gray-600 mt-2">{formatDate(entry.createdAt)}</p>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
