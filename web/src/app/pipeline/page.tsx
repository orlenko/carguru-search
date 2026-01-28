'use client';

import { useEffect, useState, useCallback } from 'react';

interface Job {
  id: string;
  command: string;
  args: string[];
  status: 'running' | 'completed' | 'failed';
  output: string[];
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
}

interface ActionConfig {
  command: string;
  args: string[];
  description: string;
}

const PIPELINE_STEPS = [
  {
    id: 'search',
    name: 'Search',
    icon: '🔍',
    description: 'Find new listings on AutoTrader',
    action: 'search',
  },
  {
    id: 'analyze',
    name: 'Analyze',
    icon: '🧠',
    description: 'AI analysis of new listings',
    action: 'analyze',
  },
  {
    id: 'outreach',
    name: 'Contact',
    icon: '📧',
    description: 'Send initial emails to sellers',
    action: 'outreach',
  },
  {
    id: 'respond',
    name: 'Respond',
    icon: '💬',
    description: 'Check and respond to emails',
    action: 'smart-respond',
  },
  {
    id: 'rank',
    name: 'Rank',
    icon: '🏆',
    description: 'Rank top offers',
    action: 'rank-offers',
  },
];

function ActionButton({
  action,
  label,
  icon,
  description,
  variant = 'primary',
  disabled,
  running,
  onRun,
}: {
  action: string;
  label: string;
  icon: string;
  description: string;
  variant?: 'primary' | 'secondary' | 'warning';
  disabled?: boolean;
  running?: boolean;
  onRun: (action: string) => void;
}) {
  const variants = {
    primary: 'bg-blue-600 hover:bg-blue-700 text-white',
    secondary: 'bg-gray-600 hover:bg-gray-700 text-white',
    warning: 'bg-yellow-600 hover:bg-yellow-700 text-white',
  };

  return (
    <button
      onClick={() => onRun(action)}
      disabled={disabled || running}
      className={`${variants[variant]} px-4 py-3 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex flex-col items-center gap-1 min-w-[120px]`}
    >
      <span className="text-2xl">{running ? '⏳' : icon}</span>
      <span className="text-sm">{label}</span>
      <span className="text-xs opacity-75">{description}</span>
    </button>
  );
}

function JobOutput({ job }: { job: Job }) {
  const statusColors = {
    running: 'bg-blue-100 text-blue-800 border-blue-200',
    completed: 'bg-green-100 text-green-800 border-green-200',
    failed: 'bg-red-100 text-red-800 border-red-200',
  };

  return (
    <div className={`rounded-lg border ${statusColors[job.status]} p-4`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="font-medium">{job.command}</span>
          <span className="text-xs opacity-75">{job.args.join(' ')}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs">
            {job.status === 'running' ? 'Running...' : job.status}
            {job.exitCode !== undefined && ` (exit ${job.exitCode})`}
          </span>
          {job.status === 'running' && (
            <span className="animate-pulse">●</span>
          )}
        </div>
      </div>
      <div className="bg-gray-900 text-gray-100 rounded p-3 font-mono text-xs max-h-64 overflow-y-auto">
        {job.output.length === 0 ? (
          <span className="text-gray-500">Waiting for output...</span>
        ) : (
          job.output.slice(-50).map((line, i) => (
            <div key={i} className={line.startsWith('[stderr]') ? 'text-red-400' : ''}>
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default function PipelinePage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [actions, setActions] = useState<Record<string, ActionConfig>>({});
  const [loading, setLoading] = useState(true);
  const [activeJob, setActiveJob] = useState<Job | null>(null);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch('/api/jobs');
      const data = await res.json();
      setJobs(data.jobs || []);
      setActions(data.availableActions || {});
      setLoading(false);

      // Update active job if it's still running
      if (activeJob && activeJob.status === 'running') {
        const updatedJob = data.jobs?.find((j: Job) => j.id === activeJob.id);
        if (updatedJob) {
          setActiveJob(updatedJob);
        }
      }
    } catch (error) {
      console.error('Failed to fetch jobs:', error);
      setLoading(false);
    }
  }, [activeJob]);

  useEffect(() => {
    fetchJobs();
  }, []);

  // Poll for updates when there's a running job
  useEffect(() => {
    if (activeJob?.status === 'running') {
      const interval = setInterval(async () => {
        const res = await fetch(`/api/jobs?id=${activeJob.id}`);
        const data = await res.json();
        if (data.job) {
          setActiveJob(data.job);
          if (data.job.status !== 'running') {
            fetchJobs(); // Refresh full list when job completes
          }
        }
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [activeJob, fetchJobs]);

  const runAction = async (action: string) => {
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (data.job) {
        setActiveJob(data.job);
        setJobs(prev => [data.job, ...prev]);
      } else if (data.error) {
        alert(data.error);
      }
    } catch (error) {
      console.error('Failed to run action:', error);
    }
  };

  const stopJob = async (jobId: string) => {
    try {
      await fetch('/api/jobs', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      });
      fetchJobs();
      if (activeJob?.id === jobId) {
        setActiveJob(null);
      }
    } catch (error) {
      console.error('Failed to stop job:', error);
    }
  };

  const runningJobs = jobs.filter(j => j.status === 'running');
  const isRunning = (action: string) => {
    const config = actions[action];
    return config && runningJobs.some(j => j.command === config.command);
  };

  if (loading) {
    return <div className="p-8 text-center text-gray-500">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Pipeline Control</h1>
        {runningJobs.length > 0 && (
          <span className="bg-blue-100 text-blue-800 px-3 py-1 rounded-full text-sm font-medium animate-pulse">
            {runningJobs.length} job{runningJobs.length > 1 ? 's' : ''} running
          </span>
        )}
      </div>

      {/* Pipeline Steps */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Pipeline Steps</h2>
        <div className="flex items-center justify-between gap-2">
          {PIPELINE_STEPS.map((step, i) => (
            <div key={step.id} className="flex items-center">
              <ActionButton
                action={step.action}
                label={step.name}
                icon={step.icon}
                description={step.description}
                running={isRunning(step.action)}
                disabled={runningJobs.length > 0}
                onRun={runAction}
              />
              {i < PIPELINE_STEPS.length - 1 && (
                <div className="text-gray-300 text-2xl mx-2">→</div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Quick Actions */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Quick Actions</h2>
        <div className="flex flex-wrap gap-3">
          <ActionButton
            action="pipeline"
            label="Full Pipeline"
            icon="🚀"
            description="Run all steps"
            variant="primary"
            running={isRunning('pipeline')}
            disabled={runningJobs.length > 0}
            onRun={runAction}
          />
          <ActionButton
            action="pipeline-no-outreach"
            label="Safe Pipeline"
            icon="🔒"
            description="No emails sent"
            variant="secondary"
            running={isRunning('pipeline-no-outreach')}
            disabled={runningJobs.length > 0}
            onRun={runAction}
          />
          <ActionButton
            action="smart-respond-include-read"
            label="Reprocess Emails"
            icon="🔄"
            description="Include read emails"
            variant="warning"
            running={isRunning('smart-respond-include-read')}
            disabled={runningJobs.length > 0}
            onRun={runAction}
          />
        </div>
      </div>

      {/* Active Job Output */}
      {activeJob && (
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">Current Job</h2>
            {activeJob.status === 'running' && (
              <button
                onClick={() => stopJob(activeJob.id)}
                className="bg-red-600 text-white px-3 py-1 rounded text-sm hover:bg-red-700"
              >
                Stop Job
              </button>
            )}
          </div>
          <JobOutput job={activeJob} />
        </div>
      )}

      {/* Recent Jobs */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Recent Jobs</h2>
        {jobs.length === 0 ? (
          <p className="text-gray-500">No jobs have been run yet.</p>
        ) : (
          <div className="space-y-3">
            {jobs.slice(0, 10).map(job => (
              <div
                key={job.id}
                className={`flex items-center justify-between p-3 rounded-lg border cursor-pointer hover:bg-gray-50 ${
                  activeJob?.id === job.id ? 'ring-2 ring-blue-500' : ''
                }`}
                onClick={() => setActiveJob(job)}
              >
                <div className="flex items-center gap-3">
                  <span className={`w-2 h-2 rounded-full ${
                    job.status === 'running' ? 'bg-blue-500 animate-pulse' :
                    job.status === 'completed' ? 'bg-green-500' : 'bg-red-500'
                  }`} />
                  <span className="font-medium">{job.command}</span>
                  <span className="text-sm text-gray-500">{job.args.join(' ')}</span>
                </div>
                <div className="text-sm text-gray-500">
                  {new Date(job.startedAt).toLocaleTimeString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
