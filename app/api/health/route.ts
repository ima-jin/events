import { NextResponse } from 'next/server';
import { isAppClaimed } from '@/lib/signing-identity';

export function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'imajin-events',
    timestamp: new Date().toISOString(),
    claimed: isAppClaimed(),
  });
}
