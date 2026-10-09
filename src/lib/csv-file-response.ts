import { NextResponse } from 'next/server';
import type { CsvFile } from '@/services/sales-service';

/** A service-built CSV as a `200` attachment download. */
export function csvFileResponse(file: CsvFile): NextResponse {
  return new NextResponse(file.content, {
    status: 200,
    headers: {
      'Content-Type': file.contentType,
      'Content-Disposition': `attachment; filename="${file.filename}"`,
    },
  });
}
