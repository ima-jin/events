import { createServer } from 'node:http';
import next from 'next';

/** Imported only by the launcher's delayed callback, after vault configuration. */
export async function startServer(options: Readonly<{ dev: boolean; claimOnly: boolean }>): Promise<void> {
  const port = Number(process.env.PORT || 3000);
  const app = next({ dev: options.dev, port });
  await app.prepare();
  const handle = app.getRequestHandler();
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
  const server = createServer((request, response) => {
    const path = request.url?.split('?')[0];
    if (options.claimOnly && path !== `${basePath}/claim` && path !== `${basePath}/api/claim`
      && !path?.startsWith(`${basePath}/_next/`)) {
      response.writeHead(503, { 'Content-Type': 'text/plain' });
      response.end('Claim-only mode; application unavailable until vault startup.');
      return;
    }
    handle(request, response).catch(() => {
      response.statusCode = 500;
      response.end('Request unavailable');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, resolve);
  });
}
