import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import pnlService from '@/lib/services/pnlService';

export const GET = withAuth(async (_request: Request, _user) => {
  try {
    const session = pnlService.getSessionPnL();
    const metrics = pnlService.getSessionMetrics();
    const latestSnapshot = pnlService.getLatestSnapshot();

    return NextResponse.json({
      session,
      metrics,
      latestSnapshot,
    });
  } catch (error) {
    console.error('Error fetching session PnL:', error);
    return NextResponse.json(
      { error: 'Failed to fetch session PnL' },
      { status: 500 }
    );
  }
});
