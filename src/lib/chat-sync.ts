import type { Logger } from '@ima-jin/logger';
import { serviceUrl } from '@/lib/kernel';

/**
 * Best-effort: move each soft DID's chat participation onto the buyer's hard DID
 * after a ticket migration. A missing chat service or a failed call is logged,
 * never thrown.
 */
export async function migrateChatParticipation(softDids: Array<string | null>, hardDid: string, log: Logger): Promise<void> {
  const chatUrl = serviceUrl('chat');
  if (!chatUrl) return;

  await Promise.all(
    softDids.filter((did): did is string => Boolean(did)).map(async (softDid) => {
      try {
        await fetch(`${chatUrl}/api/participants/migrate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fromDid: softDid, toDid: hardDid }),
        });
        log.info({ softDid, hardDid }, 'Migrated chat participation');
      } catch (chatError) {
        log.warn({ softDid, err: String(chatError) }, 'Chat migration failed (non-fatal)');
      }
    })
  );
}
