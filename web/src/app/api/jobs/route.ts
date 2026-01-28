import { NextRequest, NextResponse } from 'next/server';
import { getAllJobs, getJob, createJob, runJob, stopJob } from '@/lib/jobs';

// Available pipeline actions
const ACTIONS: Record<string, { command: string; args: string[]; description: string }> = {
  search: {
    command: 'search',
    args: [],
    description: 'Search for new listings on AutoTrader',
  },
  analyze: {
    command: 'analyze',
    args: ['all', '--limit', '10'],
    description: 'Analyze unanalyzed listings with AI',
  },
  outreach: {
    command: 'outreach',
    args: ['--limit', '5'],
    description: 'Send initial contact emails to sellers',
  },
  'smart-respond': {
    command: 'smart-respond',
    args: [],
    description: 'Check inbox and respond to dealer emails',
  },
  'smart-respond-include-read': {
    command: 'smart-respond',
    args: ['--include-read'],
    description: 'Reprocess all recent emails (including read)',
  },
  'rank-offers': {
    command: 'rank-offers',
    args: ['--top', '10', '--export'],
    description: 'Rank top offers and export report',
  },
  pipeline: {
    command: 'pipeline',
    args: [],
    description: 'Run full pipeline (search, analyze, outreach, respond)',
  },
  'pipeline-no-outreach': {
    command: 'pipeline',
    args: ['--skip-outreach', '--skip-respond'],
    description: 'Run pipeline without sending emails',
  },
};

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const jobId = searchParams.get('id');

  if (jobId) {
    const job = getJob(jobId);
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }
    return NextResponse.json({ job });
  }

  const jobs = getAllJobs();
  return NextResponse.json({
    jobs,
    availableActions: ACTIONS,
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, customArgs } = body;

    if (!action) {
      return NextResponse.json({ error: 'Action is required' }, { status: 400 });
    }

    const actionConfig = ACTIONS[action];
    if (!actionConfig) {
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }

    // Check if there's already a running job for this action
    const runningJobs = getAllJobs().filter(j => j.status === 'running' && j.command === actionConfig.command);
    if (runningJobs.length > 0) {
      return NextResponse.json({
        error: `A ${action} job is already running`,
        existingJob: runningJobs[0],
      }, { status: 409 });
    }

    const args = customArgs || actionConfig.args;
    const job = createJob(actionConfig.command, args);
    runJob(job);

    return NextResponse.json({ job });
  } catch (error) {
    console.error('Job creation error:', error);
    return NextResponse.json({ error: 'Failed to create job' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const { jobId } = body;

    if (!jobId) {
      return NextResponse.json({ error: 'Job ID is required' }, { status: 400 });
    }

    const stopped = stopJob(jobId);
    if (!stopped) {
      return NextResponse.json({ error: 'Job not found or already completed' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Job stop error:', error);
    return NextResponse.json({ error: 'Failed to stop job' }, { status: 500 });
  }
}
