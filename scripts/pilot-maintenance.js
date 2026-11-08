import 'dotenv/config';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function maintenanceResponse(request, response) {
  const probe = ['GET', 'HEAD'].includes(request.method) && request.url === '/maintenance-health';
  response.writeHead(probe ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(probe ? {} : { 'Retry-After': '300' }) });
  response.end(JSON.stringify(probe ? { status: 'maintenance' } : { success: false, error: { code: 'SERVICE_MAINTENANCE', message: 'Service is under maintenance. Keep the original claim reference and try again after staff confirm service recovery.' } }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // This process intentionally imports no application modules and starts no database writers.
  const server = createServer(maintenanceResponse);
  server.listen(Number(process.env.PORT || 4000));
  process.on('SIGTERM', () => server.close());
  process.on('SIGINT', () => server.close());
}
