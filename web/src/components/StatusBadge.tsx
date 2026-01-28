interface StatusBadgeProps {
  status: string;
}

const statusConfig: Record<string, { label: string; color: string; emoji: string }> = {
  discovered: { label: 'Discovered', color: 'bg-gray-100 text-gray-800', emoji: '🔍' },
  analyzed: { label: 'Analyzed', color: 'bg-blue-100 text-blue-800', emoji: '📊' },
  contacted: { label: 'Contacted', color: 'bg-yellow-100 text-yellow-800', emoji: '📤' },
  awaiting_response: { label: 'Awaiting Response', color: 'bg-orange-100 text-orange-800', emoji: '⏳' },
  negotiating: { label: 'Negotiating', color: 'bg-purple-100 text-purple-800', emoji: '💬' },
  viewing_scheduled: { label: 'Viewing Scheduled', color: 'bg-indigo-100 text-indigo-800', emoji: '📅' },
  inspected: { label: 'Inspected', color: 'bg-cyan-100 text-cyan-800', emoji: '👀' },
  offer_made: { label: 'Offer Made', color: 'bg-pink-100 text-pink-800', emoji: '💰' },
  purchased: { label: 'Purchased', color: 'bg-green-100 text-green-800', emoji: '✅' },
  rejected: { label: 'Rejected', color: 'bg-red-100 text-red-800', emoji: '❌' },
  withdrawn: { label: 'Withdrawn', color: 'bg-gray-100 text-gray-500', emoji: '🚫' },
};

export default function StatusBadge({ status }: StatusBadgeProps) {
  const config = statusConfig[status] || { label: status, color: 'bg-gray-100 text-gray-800', emoji: '❓' };

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${config.color}`}>
      <span className="mr-1">{config.emoji}</span>
      {config.label}
    </span>
  );
}
