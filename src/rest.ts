// ---------------------------------------------------------------------------
// rest.ts — GitHub REST v3 surface (M2: full repos/issues/pulls/contents).
// Shapes follow spec/rest-graphql-spec.md (checks-rest.ts, 55 checks).
// Extra response fields are allowed everywhere; only the listed fields are asserted.
// ---------------------------------------------------------------------------
import { store, VIEWER_LOGIN, FIXED_ISO, type Repo, type Issue, type Pull } from './store.ts';
import { readBody, authed } from './gitproto.ts';
import { sendJson, sendNoContent } from '../app.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

const SHA40 = /^[0-9a-f]{40}$/i;

async function readJsonBody(req: IncomingMessage): Promise<{ ok: boolean; value?: unknown }> {
  const raw = await readBody(req);
  if (raw.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function err(res: ServerResponse, status: number, message: string): boolean {
  sendJson(res, status, { message });
  return true;
}

function repoJson(repo: Repo) {
  return {
    id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000 },
    private: repo.private, description: repo.description,
    default_branch: repo.defaultBranch, has_issues: true,
    created_at: FIXED_ISO, updated_at: FIXED_ISO,
  };
}

function issueJson(issue: Issue) {
  return {
    id: issue.number, number: issue.number, title: issue.title, body: issue.body, state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    created_at: FIXED_ISO, updated_at: FIXED_ISO,
  };
}

function pullJson(pull: Pull, owner: string) {
  return {
    number: pull.number, title: pull.title, body: pull.body, state: pull.state,
    merged: pull.merged, merged_at: pull.merged_at, merge_commit_sha: pull.merge_commit_sha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${owner}:${pull.baseRef}` },
    created_at: FIXED_ISO, updated_at: FIXED_ISO,
  };
}

// -- query / pagination ------------------------------------------------------

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function pageParams(q: URLSearchParams): { page: number; perPage: number } {
  const perPageRaw = Number(q.get('per_page') ?? 30);
  const pageRaw = Number(q.get('page') ?? 1);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.floor(perPageRaw))) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.floor(pageRaw)) : 1;
  return { page, perPage };
}

function pageSlice<T>(items: T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

function linkHeader(req: IncomingMessage, pathname: string, q: URLSearchParams, page: number, perPage: number, total: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages <= 1) return null;
  const host = req.headers.host ?? '127.0.0.1';
  const mk = (p: number): string => {
    const sp = new URLSearchParams(q);
    sp.set('page', String(p));
    sp.set('per_page', String(perPage));
    return `<http://${host}${pathname}?${sp.toString()}>`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`${mk(page + 1)}; rel="next"`);
  if (page > 1) parts.push(`${mk(page - 1)}; rel="prev"`);
  parts.push(`${mk(1)}; rel="first"`);
  parts.push(`${mk(totalPages)}; rel="last"`);
  return parts.join(', ');
}

function listHeaders(req: IncomingMessage, pathname: string, q: URLSearchParams, page: number, perPage: number, total: number): Record<string, string> {
  const link = linkHeader(req, pathname, q, page, perPage, total);
  return link ? { link } : {};
}

// -- repo resolution ---------------------------------------------------------

function resolveRepo(req: IncomingMessage, res: ServerResponse, owner: string, name: string): Repo | null {
  if (!authed(req)) { err(res, 401, 'authentication required'); return null; }
  const repo = store.getRepo(decodeURIComponent(owner), decodeURIComponent(name));
  if (!repo) { err(res, 404, 'repository not found'); return null; }
  return repo;
}

async function jsonBodyOr400(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) { err(res, 400, 'malformed JSON body'); return null; }
  return (parsed.value ?? {}) as Record<string, unknown>;
}

function asStr(v: unknown): string { return typeof v === 'string' ? v : ''; }

/** Returns true when the request was handled (including errors). */
export async function handleRest(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
  // API root + meta (public; no auth needed).
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  // -- user repos ------------------------------------------------------------
  if (path === '/api/v3/user/repos') {
    if (method === 'POST') {
      if (!authed(req)) return err(res, 401, 'authentication required');
      const body = await jsonBodyOr400(req, res);
      if (!body) return true;
      const name = asStr(body.name);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return err(res, 422, 'invalid repository name');
      const repo = store.createRepo(name, asStr(body.description), body.private === true);
      if (!repo) return err(res, 422, 'repository already exists');
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    if (method === 'GET') {
      if (!authed(req)) return err(res, 401, 'authentication required');
      const q = queryOf(req);
      const { page, perPage } = pageParams(q);
      const repos = store.listViewerRepos();
      sendJson(res, 200, pageSlice(repos, page, perPage).map(repoJson), listHeaders(req, path, q, page, perPage, repos.length));
      return true;
    }
    return false;
  }

  // -- repo-scoped routes ----------------------------------------------------
  const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  if (!repoMatch) return false;
  const [, owner, name, rest = ''] = repoMatch;

  // GET /repos/{o}/{r} | PATCH | DELETE
  if (rest === '') {
    if (method === 'GET') {
      const repo = resolveRepo(req, res, owner, name);
      if (!repo) return true;
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      const repo = resolveRepo(req, res, owner, name);
      if (!repo) return true;
      const body = await jsonBodyOr400(req, res);
      if (!body) return true;
      if (typeof body.description === 'string') repo.description = body.description;
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      const repo = resolveRepo(req, res, owner, name);
      if (!repo) return true;
      store.deleteRepo(owner, name);
      sendNoContent(res, 204);
      return true;
    }
    return false;
  }

  // POST /repos/{o}/{r}/git/refs — create branch ref
  if (rest === '/git/refs' && method === 'POST') {
    const repo = resolveRepo(req, res, owner, name);
    if (!repo) return true;
    const body = await jsonBodyOr400(req, res);
    if (!body) return true;
    const ref = asStr(body.ref);
    const sha = asStr(body.sha);
    const m = /^refs\/heads\/(.+)$/.exec(ref);
    if (!m) return err(res, 422, 'invalid ref');
    if (!SHA40.test(sha)) return err(res, 422, 'invalid sha');
    const obj = repo.getObject(sha.toLowerCase());
    if (!obj || obj.type !== 'commit') return err(res, 422, 'sha is not a commit');
    if (repo.refTip(ref)) return err(res, 422, 'reference already exists');
    repo.setBranch(m[1], sha.toLowerCase());
    sendJson(res, 201, { ref, object: { sha: sha.toLowerCase(), type: 'commit' } });
    return true;
  }

  // GET /repos/{o}/{r}/branches
  if (rest === '/branches' && method === 'GET') {
    const repo = resolveRepo(req, res, owner, name);
    if (!repo) return true;
    sendJson(res, 200, repo.branches().map((b) => ({ name: b.name, commit: { sha: b.sha } })));
    return true;
  }

  // GET /repos/{o}/{r}/commits[?sha=<branch>]
  if (rest === '/commits' && method === 'GET') {
    const repo = resolveRepo(req, res, owner, name);
    if (!repo) return true;
    const q = queryOf(req);
    const shaParam = q.get('sha');
    let tip: string | undefined;
    if (shaParam) {
      tip = repo.branchTip(shaParam) ?? (repo.getObject(shaParam)?.type === 'commit' ? shaParam : undefined);
    } else {
      tip = repo.branchTip(repo.defaultBranch);
    }
    if (!tip) return err(res, 404, 'no commits');
    sendJson(res, 200, repo.commitHistory(tip).map((c) => ({
      sha: c.sha,
      commit: { message: c.message, author: { name: 'Conformance', email: 'conformance@make.fun' } },
    })));
    return true;
  }

  // -- contents ---------------------------------------------------------------
  const contentsMatch = /^\/contents\/(.+)$/.exec(rest);
  if (contentsMatch) {
    const filePath = decodeURIComponent(contentsMatch[1]);
    if (method === 'GET') {
      const repo = resolveRepo(req, res, owner, name);
      if (!repo) return true;
      const q = queryOf(req);
      const ref = q.get('ref') ?? repo.defaultBranch;
      const file = repo.readFile(ref, filePath);
      if (file) {
        sendJson(res, 200, {
          type: 'file', encoding: 'base64', name: filePath.split('/').pop(),
          path: filePath, sha: file.blobOid, size: file.content.length,
          content: file.content.toString('base64'),
        });
        return true;
      }
      const dir = repo.listDir(ref, filePath);
      if (dir) {
        sendJson(res, 200, dir.map((e) => ({ type: e.type, name: e.name, path: e.path, sha: e.sha })));
        return true;
      }
      return err(res, 404, 'not found');
    }
    if (method === 'PUT') {
      const repo = resolveRepo(req, res, owner, name);
      if (!repo) return true;
      const body = await jsonBodyOr400(req, res);
      if (!body) return true;
      const branch = asStr(body.branch) || repo.defaultBranch;
      if (!repo.branchTip(branch) && repo.refs.size > 0 && !repo.branchTip(branch)) {
        // Branch must exist once the repo has any refs; unborn repo uses default branch.
        if ([...repo.refs.keys()].some((r) => r.startsWith('refs/heads/'))) return err(res, 404, 'branch not found');
      }
      const contentRaw = asStr(body.content);
      if (!contentRaw) return err(res, 422, 'content is required');
      let content: Buffer;
      try {
        content = Buffer.from(contentRaw, 'base64');
      } catch {
        return err(res, 422, 'content is not valid base64');
      }
      const existing = repo.readFile(branch, filePath);
      if (existing) {
        const givenSha = asStr(body.sha);
        if (givenSha && givenSha.toLowerCase() !== existing.blobOid.toLowerCase()) {
          return err(res, 409, 'stale sha: file has changed');
        }
      }
      const blobOid = repo.putObject('blob', content);
      const changes = new Map<string, { mode: string; oid: string } | null>();
      changes.set(filePath, { mode: '100644', oid: blobOid });
      const commitOid = repo.commitOnBranch(branch, asStr(body.message) || `Update ${filePath}`, changes);
      sendJson(res, existing ? 200 : 201, {
        content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
        commit: { sha: commitOid, message: asStr(body.message) || `Update ${filePath}` },
      });
      return true;
    }
    if (method === 'DELETE') {
      const repo = resolveRepo(req, res, owner, name);
      if (!repo) return true;
      const body = await jsonBodyOr400(req, res);
      if (!body) return true;
      const branch = asStr(body.branch) || repo.defaultBranch;
      const existing = repo.readFile(branch, filePath);
      if (!existing) return err(res, 404, 'not found');
      const givenSha = asStr(body.sha);
      if (givenSha && givenSha.toLowerCase() !== existing.blobOid.toLowerCase()) {
        return err(res, 409, 'stale sha: file has changed');
      }
      const changes = new Map<string, { mode: string; oid: string } | null>();
      changes.set(filePath, null);
      const commitOid = repo.commitOnBranch(branch, asStr(body.message) || `Delete ${filePath}`, changes);
      sendJson(res, 200, { commit: { sha: commitOid, message: asStr(body.message) || `Delete ${filePath}` } });
      return true;
    }
    return false;
  }

  // -- labels -----------------------------------------------------------------
  if (rest === '/labels' && method === 'POST') {
    const repo = resolveRepo(req, res, owner, name);
    if (!repo) return true;
    const body = await jsonBodyOr400(req, res);
    if (!body) return true;
    const labelName = asStr(body.name);
    if (!labelName) return err(res, 422, 'label name is required');
    const color = asStr(body.color) || 'ededed';
    repo.labels.set(labelName, { name: labelName, color });
    sendJson(res, 201, { name: labelName, color });
    return true;
  }

  // -- issues -----------------------------------------------------------------
  if (rest === '/issues') {
    if (method === 'POST') {
      const repo = resolveRepo(req, res, owner, name);
      if (!repo) return true;
      const body = await jsonBodyOr400(req, res);
      if (!body) return true;
      const labels = Array.isArray(body.labels) ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return err(res, 422, `label does not exist: ${label}`);
      }
      const issue = repo.createIssue(asStr(body.title), asStr(body.body), labels);
      sendJson(res, 201, issueJson(issue));
      return true;
    }
    if (method === 'GET') {
      const repo = resolveRepo(req, res, owner, name);
      if (!repo) return true;
      const q = queryOf(req);
      const { page, perPage } = pageParams(q);
      const state = q.get('state') ?? 'open';
      const sort = q.get('sort') ?? 'created';
      const direction = q.get('direction') ?? 'desc';
      let items = [...repo.issues];
      if (state !== 'all') items = items.filter((i) => i.state === state);
      if (sort === 'created') {
        items.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      sendJson(res, 200, pageSlice(items, page, perPage).map(issueJson), listHeaders(req, path, q, page, perPage, items.length));
      return true;
    }
    return false;
  }

  const issueMatch = /^\/issues\/(\d+)(\/comments)?$/.exec(rest);
  if (issueMatch) {
    const num = Number(issueMatch[1]);
    const isComments = issueMatch[2] === '/comments';
    const repo = resolveRepo(req, res, owner, name);
    if (!repo) return true;
    const issue = repo.issues.find((i) => i.number === num);
    if (isComments) {
      if (!issue) return err(res, 404, 'issue not found');
      if (method === 'POST') {
        const body = await jsonBodyOr400(req, res);
        if (!body) return true;
        const comment = { id: ++repo.commentSeq, body: asStr(body.body) };
        issue.comments.push(comment);
        sendJson(res, 201, { id: comment.id, body: comment.body });
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body })));
        return true;
      }
      return false;
    }
    if (!issue) return err(res, 404, 'issue not found');
    if (method === 'GET') {
      sendJson(res, 200, issueJson(issue));
      return true;
    }
    if (method === 'PATCH') {
      const body = await jsonBodyOr400(req, res);
      if (!body) return true;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      sendJson(res, 200, issueJson(issue));
      return true;
    }
    return false;
  }

  // -- pulls ------------------------------------------------------------------
  if (rest === '/pulls') {
    if (method === 'POST') {
      const repo = resolveRepo(req, res, owner, name);
      if (!repo) return true;
      const body = await jsonBodyOr400(req, res);
      if (!body) return true;
      const head = asStr(body.head);
      const base = asStr(body.base) || repo.defaultBranch;
      const pull = repo.createPull(asStr(body.title), asStr(body.body), head, base);
      if (!pull) return err(res, 422, 'head or base branch not found');
      sendJson(res, 201, pullJson(pull, owner));
      return true;
    }
    if (method === 'GET') {
      const repo = resolveRepo(req, res, owner, name);
      if (!repo) return true;
      const q = queryOf(req);
      const { page, perPage } = pageParams(q);
      const state = q.get('state') ?? 'open';
      let items = [...repo.pulls];
      if (state !== 'all') items = items.filter((p) => p.state === state);
      items.sort((a, b) => a.number - b.number);
      sendJson(res, 200, pageSlice(items, page, perPage).map((p) => pullJson(p, owner)), listHeaders(req, path, q, page, perPage, items.length));
      return true;
    }
    return false;
  }

  const pullMatch = /^\/pulls\/(\d+)(\/files|\/merge)?$/.exec(rest);
  if (pullMatch) {
    const num = Number(pullMatch[1]);
    const sub = pullMatch[2] ?? '';
    const repo = resolveRepo(req, res, owner, name);
    if (!repo) return true;
    const pull = repo.pulls.find((p) => p.number === num);
    if (!pull) return err(res, 404, 'pull request not found');
    if (sub === '/files' && method === 'GET') {
      sendJson(res, 200, pull.files.map((f) => ({
        filename: f.filename,
        status: f.status === 'removed' ? 'changed' : f.status,
        additions: f.additions, deletions: f.deletions, changes: f.changes,
      })));
      return true;
    }
    if (sub === '/merge' && method === 'PUT') {
      const body = await jsonBodyOr400(req, res);
      if (!body) return true;
      if (pull.merged) {
        sendJson(res, 200, { merged: true, sha: pull.merge_commit_sha, message: `Merge pull request #${pull.number}` });
        return true;
      }
      if (pull.state !== 'open') return err(res, 405, 'pull request is closed');
      if (!repo.pullMergeable(pull)) return err(res, 405, 'merge conflict');
      const sha = repo.mergePull(pull);
      if (!sha) return err(res, 405, 'merge conflict');
      sendJson(res, 200, { merged: true, sha, message: `Merge pull request #${pull.number}` });
      return true;
    }
    if (sub === '' && method === 'GET') {
      sendJson(res, 200, pullJson(pull, owner));
      return true;
    }
    return false;
  }

  return false;
}
