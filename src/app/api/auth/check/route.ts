import { NextResponse } from 'next/server';
import { configLoader } from '@/lib/config/configLoader';

export async function GET() {
  try {
    // Load config to check if password is set
    const config = await configLoader.loadConfig();
    const dashboardPassword = config.global?.server?.dashboardPassword;

    // Only require password if it's set and not the default "admin"
    return NextResponse.json({
      passwordRequired: !!dashboardPassword && dashboardPassword.length > 0 && dashboardPassword !== 'admin',
    });
  } catch (error) {
    console.error('Failed to check auth status:', error);
    return NextResponse.json({ passwordRequired: false });
  }
}