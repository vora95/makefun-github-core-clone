// app.ts — the forge server: git smart HTTP + REST v3 + GraphQL + MCP.
// main.ts (lifecycle) stays as shipped; this file is the contest surface.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './src/gitproto.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestSeq = 0;

export function sendNoContent(res: ServerResponse, status = 204): void {
  const reqId = `forge-${++requestSeq}`;
  res.writeHead(status, { 'x-github-request-id': reqId });
  res.end();
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  const reqId = `forge-${++requestSeq}`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': reqId,
    ...headers,
  });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /<owner>/<repo>.git/{info/refs,git-upload-pack,git-receive-pack}
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch) {
          const [, owner, repo, service] = gitMatch;
          if (service === 'info/refs' && method === 'GET') {
            await handleInfoRefs(req, res, owner, repo);
            return;
          }
          if (service === 'git-upload-pack' && method === 'POST') {
            await handleUploadPack(req, res, owner, repo);
            return;
          }
          if (service === 'git-receive-pack' && method === 'POST') {
            await handleReceivePack(req, res, owner, repo);
            return;
          }
        }

        // REST v3 surface.
        if (path.startsWith('/api/v3')) {
          if (await handleRest(req, res, path, method)) return;
        }

        // GraphQL v4 surface (M3).
        if (method === 'POST' && path === '/api/graphql') {
          if (await handleGraphql(req, res)) return;
        }

        // MCP surface (M4).
        if (path === '/mcp') {
          if (await handleMcp(req, res)) return;
        }

        // MCP lands here (wired in M4).
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) {
          try { sendJson(res, 500, { message: 'internal error' }); } catch { /* socket gone */ }
        }
        process.stderr.write(`[app] handler error: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    })();
  });
}
