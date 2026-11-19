// The git surface. A module answers a request and returns true, or returns false to say "not mine".
import type { IncomingMessage, ServerResponse } from 'node:http';

export async function handle(_req: IncomingMessage, _res: ServerResponse): Promise<boolean> {
  return false;
}
