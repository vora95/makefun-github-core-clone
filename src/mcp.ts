// ---------------------------------------------------------------------------
// mcp.ts — Model Context Protocol surface (M4).
// Transport: Streamable HTTP, JSON-RPC 2.0 over POST /mcp (single JSON body).
// Era modern preferred (server/discover, revision 2026-07-28); legacy
// initialize handshake also answered. Auth (Bearer, any non-empty token)
// is decided before any method — unauthenticated -> HTTP 401.
// Shapes follow program/env/src/checks-mcp.ts + mcp-client.ts.
// ---------------------------------------------------------------------------
import { store, VIEWER_LOGIN, VIEWER_ID, type Repo, type Issue, type Pull } from './store.ts';
import { readBody, authed } from './gitproto.ts';
import { sendJson } from '../app.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SUPPORTED_VERSIONS = [MODERN_REVISION, ...LEGACY_REVISIONS];

const RPC_PARSE_ERROR = -32700;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// -- JSON-RPC plumbing ---------------------------------------------------------

type JsonRpcId = string | number | null;

function rpcResult(res: ServerResponse, id: JsonRpcId, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, result });
}

function rpcError(res: ServerResponse, id: JsonRpcId, code: number, message: string, httpStatus = 200): void {
  sendJson(res, httpStatus, { jsonrpc: '2.0', id, error: { code, message } });
}

// -- tool definitions (static: tools/list must be byte-identical every call) --

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the repository to create.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the issue.' },
        body: { type: 'string', description: 'Body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the pull request.' },
        head: { type: 'string', description: 'Name of the head branch.' },
        base: { type: 'string', description: 'Name of the base branch.' },
        body: { type: 'string', description: 'Body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        pull_number: { type: 'integer', description: 'Number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

// -- result shapes (same fields as the REST surface) --------------------------

function repoJson(repo: Repo) {
  return {
    id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID },
    private: repo.private, description: repo.description,
    default_branch: repo.defaultBranch, has_issues: true,
    created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z',
  };
}

function issueJson(issue: Issue) {
  return {
    id: issue.number, number: issue.number, title: issue.title, body: issue.body,
    state: issue.state, labels: issue.labels.map((name) => ({ name })),
    created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z',
  };
}

function pullJson(pull: Pull, owner: string) {
  return {
    number: pull.number, title: pull.title, body: pull.body, state: pull.state,
    merged: pull.merged, merged_at: pull.merged_at, merge_commit_sha: pull.merge_commit_sha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${owner}:${pull.baseRef}` },
    created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z',
  };
}

function toolOk(data: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function toolErr(message: string) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// -- argument helpers ----------------------------------------------------------

type Args = Record<string, unknown>;

function asStr(v: unknown): string { return typeof v === 'string' ? v : ''; }

function asInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
}

/** Missing/invalid required arguments, or null when all are present. */
function missingRequired(args: Args, spec: { name: string; kind: 'string' | 'integer' }[]): string | null {
  for (const s of spec) {
    const v = args[s.name];
    if (s.kind === 'string') {
      if (typeof v !== 'string' || v.trim() === '') return s.name;
    } else if (asInt(v) === null) {
      return s.name;
    }
  }
  return null;
}

function resolveRepo(owner: string, name: string): Repo | null {
  return store.getRepo(owner, name) ?? null;
}

// -- tool execution --------------------------------------------------------------

function callTool(name: string, args: Args): { content: { type: string; text: string }[]; structuredContent?: unknown; isError?: boolean } {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) return toolErr(`unknown tool: ${name}`); // caller converts to -32602

  switch (name) {
    case 'create_repo': {
      const missing = missingRequired(args, [{ name: 'name', kind: 'string' }]);
      if (missing) return toolErr(`Missing required argument: ${missing}`);
      const repoName = asStr(args.name);
      if (!NAME_RE.test(repoName)) return toolErr('invalid repository name');
      const repo = store.createRepo(repoName, asStr(args.description), args.private === true);
      if (!repo) return toolErr('repository already exists');
      return toolOk(repoJson(repo));
    }
    case 'get_repo': {
      const missing = missingRequired(args, [{ name: 'owner', kind: 'string' }, { name: 'repo', kind: 'string' }]);
      if (missing) return toolErr(`Missing required argument: ${missing}`);
      const repo = resolveRepo(asStr(args.owner), asStr(args.repo));
      if (!repo) return toolErr('repository not found');
      return toolOk(repoJson(repo));
    }
    case 'create_issue': {
      const missing = missingRequired(args, [
        { name: 'owner', kind: 'string' }, { name: 'repo', kind: 'string' }, { name: 'title', kind: 'string' },
      ]);
      if (missing) return toolErr(`Missing required argument: ${missing}`);
      const repo = resolveRepo(asStr(args.owner), asStr(args.repo));
      if (!repo) return toolErr('repository not found');
      const issue = repo.createIssue(asStr(args.title), asStr(args.body), []);
      return toolOk(issueJson(issue));
    }
    case 'list_issues': {
      const missing = missingRequired(args, [{ name: 'owner', kind: 'string' }, { name: 'repo', kind: 'string' }]);
      if (missing) return toolErr(`Missing required argument: ${missing}`);
      const repo = resolveRepo(asStr(args.owner), asStr(args.repo));
      if (!repo) return toolErr('repository not found');
      const state = asStr(args.state) || 'open';
      let items = [...repo.issues];
      if (state !== 'all') items = items.filter((i) => i.state === state);
      const data = { issues: items.map(issueJson) };
      return { content: [{ type: 'text', text: JSON.stringify(data.issues) }], structuredContent: data };
    }
    case 'create_pull_request': {
      const missing = missingRequired(args, [
        { name: 'owner', kind: 'string' }, { name: 'repo', kind: 'string' }, { name: 'title', kind: 'string' },
        { name: 'head', kind: 'string' }, { name: 'base', kind: 'string' },
      ]);
      if (missing) return toolErr(`Missing required argument: ${missing}`);
      const owner = asStr(args.owner);
      const repo = resolveRepo(owner, asStr(args.repo));
      if (!repo) return toolErr('repository not found');
      const pull = repo.createPull(asStr(args.title), asStr(args.body), asStr(args.head), asStr(args.base));
      if (!pull) return toolErr('head or base branch not found');
      return toolOk(pullJson(pull, owner));
    }
    case 'merge_pull_request': {
      const missing = missingRequired(args, [
        { name: 'owner', kind: 'string' }, { name: 'repo', kind: 'string' }, { name: 'pull_number', kind: 'integer' },
      ]);
      if (missing) return toolErr(`Missing required argument: ${missing}`);
      const owner = asStr(args.owner);
      const repo = resolveRepo(owner, asStr(args.repo));
      if (!repo) return toolErr('repository not found');
      const number = asInt(args.pull_number)!;
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return toolErr('pull request not found');
      if (pull.merged) return toolOk({ merged: true, number, sha: pull.merge_commit_sha, message: `Merge pull request #${number}` });
      if (pull.state !== 'open') return toolErr('pull request is closed');
      if (!repo.pullMergeable(pull)) return toolErr('merge conflict');
      const sha = repo.mergePull(pull);
      if (!sha) return toolErr('merge conflict');
      return toolOk({ merged: true, number, sha, message: `Merge pull request #${number}` });
    }
    default:
      return toolErr(`unknown tool: ${name}`);
  }
}

// -- request handler ------------------------------------------------------------

/** Returns true when the request was handled (path is /mcp). */
export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method ?? 'GET';

  // Legacy session close: DELETE, best-effort, no body.
  if (method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return true;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { message: 'method not allowed' });
    return true;
  }

  // Auth is decided before any method or tool exists.
  if (!authed(req)) {
    sendJson(res, 401, { message: 'authentication required' });
    return true;
  }

  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    rpcError(res, null, RPC_PARSE_ERROR, 'Parse error', 400);
    return true;
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    rpcError(res, null, RPC_INVALID_PARAMS, 'Invalid Request');
    return true;
  }
  const msg = body as Record<string, unknown>;
  const id: JsonRpcId = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : null;
  const isNotification = msg.id === undefined;

  try {
    if (typeof msg.method !== 'string' || msg.method === '') {
      if (!isNotification) rpcError(res, id, RPC_INVALID_PARAMS, 'Invalid Request');
      else { res.writeHead(202); res.end(); }
      return true;
    }

    const params = (typeof msg.params === 'object' && msg.params !== null && !Array.isArray(msg.params))
      ? (msg.params as Args) : {};
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };

    switch (msg.method) {
      case 'server/discover': {
        rpcResult(res, id, {
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo,
          _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
        });
        return true;
      }
      case 'initialize': {
        const requested = asStr((params as Args).protocolVersion);
        const negotiated = LEGACY_REVISIONS.includes(requested) ? requested : LEGACY_REVISIONS[0]!;
        rpcResult(res, id, { protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo });
        return true;
      }
      case 'notifications/initialized': {
        // Notification: no JSON-RPC response.
        res.writeHead(202);
        res.end();
        return true;
      }
      case 'ping': {
        rpcResult(res, id, {});
        return true;
      }
      case 'tools/list': {
        rpcResult(res, id, { tools: TOOLS });
        return true;
      }
      case 'tools/call': {
        const toolName = asStr(params.name);
        const toolArgs = (typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments))
          ? (params.arguments as Args) : {};
        if (toolName === '' || !TOOLS.some((t) => t.name === toolName)) {
          rpcError(res, id, RPC_INVALID_PARAMS, `unknown tool: ${toolName || '(none)'}`);
          return true;
        }
        const result = callTool(toolName, toolArgs);
        rpcResult(res, id, result);
        return true;
      }
      default: {
        if (isNotification) {
          res.writeHead(202);
          res.end();
          return true;
        }
        rpcError(res, id, RPC_METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
        return true;
      }
    }
  } catch (err) {
    // Never surface HTTP 500 for an MCP call: answer a JSON-RPC error instead.
    if (!res.headersSent) {
      try { rpcError(res, id, RPC_INTERNAL_ERROR, err instanceof Error ? err.message : 'Internal error'); } catch { /* socket gone */ }
    }
    process.stderr.write(`[mcp] handler error: ${err instanceof Error ? err.message : String(err)}\n`);
    return true;
  }
}
