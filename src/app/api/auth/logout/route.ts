import { NextRequest, NextResponse } from 'next/server';

export async function POST(_request: NextRequest) {
  const response = NextResponse.json({ success: true });

  // Delete the auth cookies
  response.cookies.delete('auth-token');
  response.cookies.delete('password-required');

  return response;
}