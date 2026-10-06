import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'imajin-events',
    timestamp: new Date().toISOString(),
  });
}
