import QRCode from 'qrcode';
import { createLogger } from '@ima-jin/logger';
import { createTicketQrToken } from '@/lib/ticket-qr-token';

const log = createLogger('events');

/** Ticket QR code as a data URI (light-on-dark, matches the kernel email templates). Empty string on failure. */
export async function generateQRCode(ticketId: string): Promise<string> {
  try {
    return await QRCode.toDataURL(createTicketQrToken(ticketId), {
      width: 200,
      margin: 1,
      color: { dark: '#ffffff', light: '#1a1a1a' },
    });
  } catch (error) {
    log.error({ err: String(error) }, 'QR code generation failed');
    return '';
  }
}
