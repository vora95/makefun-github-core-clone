// ---------------------------------------------------------------------------
// gitproto.ts — smart HTTP git protocol (v2 + v0) + receive-pack.
// Framing verified against program/env/src/git-client.ts.
// ---------------------------------------------------------------------------
import {
  ZERO_OID, collectReachable, encodePktLine, isObjectId, parseCommit, parseTag,
  readPack, sidebandPack, writePack, type GitObject,
} from './git.ts';
import { store, DEFAULT_BRANCH, type Repo } from './store.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function authed(req: IncomingMessage): boolean {
  const h = req.headers.authorization;
  return !!h && h.startsWith('Bearer ') && h.slice(7).trim().length > 0;
}

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': body.length });
  res.end(body);
}

// Incremental pkt-line reader: returns payload lines and the byte offset where
// parsing stopped (at a flush, or at end of buffer). Throws on bad framing.
export function readPktLines(buf: Buffer): { lines: Buffer[]; offset: number; flushed: boolean } {
  const lines: Buffer[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const hex = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad pkt-line length');
    const len = parseInt(hex, 16);
    if (len === 0) return { lines, offset: offset + 4, flushed: true };
    if (len === 1) { offset += 4; continue; } // delim: skip, keep parsing
    if (len === 2) { offset += 4; continue; } // response-end: skip
    if (len < 4 || offset + len > buf.length) throw new Error('truncated pkt-line');
    lines.push(buf.subarray(offset + 4, offset + len));
    offset += len;
  }
  if (offset !== buf.length) throw new Error('trailing bytes in pkt-line stream');
  return { lines, offset, flushed: false };
}

function lineStr(b: Buffer): string { return b.toString('utf8').replace(/\n$/, ''); }

// -- refs --------------------------------------------------------------------

interface RefLine { oid: string; name: string; peeled?: string; symrefTarget?: string }

function peelToCommit(repo: Repo, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 10; i++) {
    const obj = repo.getObject(cur);
    if (!obj || obj.type !== 'tag') return cur;
    cur = parseTag(obj.data).object;
  }
  return cur;
}

function allRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const headTip = repo.branchTip(repo.defaultBranch);
  if (headTip) out.push({ oid: headTip, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const line: RefLine = { oid, name };
    const obj = repo.getObject(oid);
    if (name.startsWith('refs/tags/') && obj?.type === 'tag') line.peeled = peelToCommit(repo, oid);
    out.push(line);
  }
  return out;
}

// -- advertisement ------------------------------------------------------------

const UPLOAD_CAPS_V2 = ['ls-refs=unborn', 'fetch=shallow', 'object-format=sha1', 'agent=forge/1'];
const RECEIVE_CAPS_V2 = ['report-status', 'report-status-v2', 'side-band-64k', 'delete-refs', 'ofs-delta', 'object-format=sha1', 'agent=forge/1'];
const UPLOAD_CAPS_V0 = 'side-band-64k multi_ack thin-pack ofs-delta shallow agent=forge/1 symref=HEAD:refs/heads/main';
const RECEIVE_CAPS_V0 = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=forge/1 symref=HEAD:refs/heads/main';

function advertiseV2(res: ServerResponse, contentType: string, caps: string[]): void {
  const parts: Buffer[] = [encodePktLine('version 2\n')];
  for (const c of caps) parts.push(encodePktLine(`${c}\n`));
  parts.push(PKT_FLUSH);
  send(res, 200, contentType, Buffer.concat(parts));
}

function advertiseV0(res: ServerResponse, service: string, contentType: string, caps: string, repo: Repo): void {
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = allRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((r, i) => {
      const capSuffix = i === 0 ? `\0${caps}` : '';
      parts.push(encodePktLine(`${r.oid} ${r.name}${capSuffix}\n`));
      if (r.peeled) parts.push(encodePktLine(`${r.peeled} ${r.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  send(res, 200, contentType, Buffer.concat(parts));
}

// -- fetch computation ---------------------------------------------------------

interface WalkResult { commits: Set<string>; boundary: Set<string>; extra: Set<string> }

// BFS over commit parents. gen 1 = roots. boundary = commits at generation == depth.
// stopAt commits are included but their parents are not traversed.
function walkCommits(repo: Repo, roots: Iterable<string>, opts: { depth?: number; stopAt?: ReadonlySet<string> } = {}): WalkResult {
  const commits = new Set<string>();
  const boundary = new Set<string>();
  const extra = new Set<string>(); // non-commit objects on the path (annotated tags)
  const gen = new Map<string, number>();
  const queue: string[] = [];
  const maxDepth = opts.depth ?? Number.POSITIVE_INFINITY;
  for (const r of roots) {
    if (!isObjectId(r)) continue;
    if ((gen.get(r) ?? Infinity) > 1) { gen.set(r, 1); queue.push(r); }
  }
  while (queue.length) {
    const oid = queue.shift()!;
    const g = gen.get(oid)!;
    if (commits.has(oid) || extra.has(oid)) continue;
    const obj = repo.getObject(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      extra.add(oid);
      const target = parseTag(obj.data).object;
      if (!gen.has(target)) { gen.set(target, g); queue.push(target); }
      continue;
    }
    if (obj.type !== 'commit') continue;
    commits.add(oid);
    if (opts.stopAt?.has(oid)) continue;
    if (g >= maxDepth) { boundary.add(oid); continue; }
    for (const p of parseCommit(obj.data).parents) {
      if ((gen.get(p) ?? Infinity) > g + 1) { gen.set(p, g + 1); queue.push(p); }
    }
  }
  return { commits, boundary, extra };
}

interface FetchPlan {
  packObjects: GitObject[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
}

function planFetch(repo: Repo, wants: string[], haves: string[], clientShallow: string[], deepen: number | null, deepenNot: string[]): FetchPlan {
  const S = new Set(clientShallow);
  const wantWalk = walkCommits(repo, wants, { depth: deepen ?? undefined, stopAt: deepen == null ? S : undefined });
  const haveWalk = walkCommits(repo, [...haves, ...deepenNot], { stopAt: S });
  const held = new Set([...haveWalk.commits, ...haveWalk.extra]);
  const sendCommits = new Set<string>();
  for (const c of [...wantWalk.commits, ...wantWalk.extra]) if (!held.has(c)) sendCommits.add(c);
  // Object expansion: each sent commit + its tree + blobs (depth 1 from each commit),
  // MINUS every object the client already holds (object-level, not commit-level:
  // a new commit may reuse the previous tree/blobs).
  const lookup = (oid: string) => repo.getObject(oid);
  const wantOids = collectReachable(sendCommits, lookup, { depth: 1, allowMissing: true });
  const haveOids = collectReachable(haveWalk.commits, lookup, { stopAt: S, allowMissing: true });
  for (const t of haveWalk.extra) {
    for (const oid of collectReachable([t], lookup, { depth: 1, allowMissing: true })) haveOids.add(oid);
  }
  const packObjects: GitObject[] = [];
  for (const oid of wantOids) {
    if (haveOids.has(oid)) continue;
    const obj = repo.getObject(oid);
    if (obj) packObjects.push(obj);
  }
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (deepen != null) {
    for (const c of wantWalk.boundary) if (sendCommits.has(c)) shallow.push(c);
    for (const s of S) {
      const obj = repo.getObject(s);
      if (!obj || obj.type !== 'commit') continue;
      if (parseCommit(obj.data).parents.some((p) => sendCommits.has(p))) unshallow.push(s);
    }
  }
  const acks = haves.filter((h) => wantWalk.commits.has(h));
  return { packObjects, shallow, unshallow, acks, nak: acks.length === 0 };
}

// -- handlers ------------------------------------------------------------------

function resolveRepo(owner: string, repoName: string): Repo | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(owner) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoName)) return null;
  return store.getRepo(owner, repoName) ?? null;
}

export async function handleInfoRefs(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://x');
  const service = url.searchParams.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    send(res, 400, 'text/plain', Buffer.from('bad service'));
    return true;
  }
  if (!authed(req)) { send(res, 401, 'application/json', Buffer.from(JSON.stringify({ message: 'authentication required' }))); return true; }
  const repo = resolveRepo(owner, repoName);
  if (!repo) { send(res, 404, 'application/json', Buffer.from(JSON.stringify({ message: 'repository not found' }))); return true; }
  const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  const ct = service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
  if (v2) advertiseV2(res, ct, service === 'git-upload-pack' ? UPLOAD_CAPS_V2 : RECEIVE_CAPS_V2);
  else advertiseV0(res, service, ct, service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0, repo);
  return true;
}

function parseV2Request(lines: Buffer[]): { command: string; args: string[] } {
  const strs = lines.map(lineStr);
  const command = strs[0]?.split('=')[1] ?? '';
  const args: string[] = [];
  let afterDelim = false;
  // readPktLines skips delim packets, so args are everything after the command line
  // (agent/object-format lines are also present before delim — filter them out).
  for (const s of strs.slice(1)) {
    if (s.startsWith('agent=') || s.startsWith('object-format=')) continue;
    args.push(s);
  }
  void afterDelim;
  return { command, args };
}

export async function handleUploadPack(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string): Promise<boolean> {
  if (!authed(req)) { send(res, 401, 'application/json', Buffer.from(JSON.stringify({ message: 'authentication required' }))); return true; }
  const repo = resolveRepo(owner, repoName);
  if (!repo) { send(res, 404, 'application/json', Buffer.from(JSON.stringify({ message: 'repository not found' }))); return true; }
  const body = await readBody(req);
  let lines: Buffer[];
  try {
    lines = readPktLines(body).lines;
  } catch {
    send(res, 400, 'text/plain', Buffer.from('malformed pkt-line stream'));
    return true;
  }
  const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  if (v2) return handleUploadPackV2(res, repo, lines);
  return handleUploadPackV0(res, repo, lines);
}

function handleUploadPackV2(res: ServerResponse, repo: Repo, lines: Buffer[]): boolean {
  const { command, args } = parseV2Request(lines);
  if (command === 'ls-refs') {
    let peel = false, symrefs = false, unborn = false;
    const prefixes: string[] = [];
    for (const a of args) {
      if (a === 'peel') peel = true;
      else if (a === 'symrefs') symrefs = true;
      else if (a === 'unborn') unborn = true;
      else if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
    }
    const parts: Buffer[] = [];
    const refs = allRefs(repo);
    const keep = (name: string) => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    if (refs.length === 0) {
      if (unborn) {
        if (keep('HEAD')) parts.push(encodePktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
      }
    } else {
      for (const r of refs) {
        if (!keep(r.name)) continue;
        let line = `${r.oid} ${r.name}`;
        if (symrefs && r.symrefTarget) line += ` symref-target:${r.symrefTarget}`;
        if (peel && r.peeled) line += ` peeled:${r.peeled}`;
        parts.push(encodePktLine(`${line}\n`));
      }
    }
    parts.push(PKT_FLUSH);
    send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
    return true;
  }
  if (command !== 'fetch') {
    send(res, 400, 'text/plain', Buffer.from('unknown command'));
    return true;
  }
  const wants: string[] = []; const haves: string[] = []; const shallow: string[] = [];
  let deepen: number | null = null; const deepenNot: string[] = [];
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) shallow.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) deepen = parseInt(a.slice(7), 10);
    else if (a.startsWith('deepen-not ')) deepenNot.push(a.slice(11).trim());
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, done: ignored (superset ok)
  }
  const plan = planFetch(repo, wants, haves, shallow, deepen, deepenNot);
  const pack = writePack(plan.packObjects);
  const parts: Buffer[] = [encodePktLine('acknowledgments\n')];
  if (plan.nak) parts.push(encodePktLine('NAK\n'));
  else {
    for (const a of plan.acks) parts.push(encodePktLine(`ACK ${a}\n`));
    parts.push(encodePktLine('ready\n'));
  }
  parts.push(PKT_DELIM);
  if (deepen != null && (plan.shallow.length || plan.unshallow.length)) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const s of plan.shallow) parts.push(encodePktLine(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(encodePktLine(`unshallow ${s}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(PKT_FLUSH);
  send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
  return true;
}

function handleUploadPackV0(res: ServerResponse, repo: Repo, lines: Buffer[]): boolean {
  const wants: string[] = []; const haves: string[] = []; const shallow: string[] = [];
  let deepen: number | null = null; const deepenNot: string[] = [];
  for (const raw of lines.map(lineStr)) {
    const firstSpace = raw.indexOf(' ');
    const verb = firstSpace < 0 ? raw : raw.slice(0, firstSpace);
    const rest = firstSpace < 0 ? '' : raw.slice(firstSpace + 1);
    if (verb === 'want') wants.push(rest.split(' ')[0]);
    else if (verb === 'have') haves.push(rest);
    else if (verb === 'shallow') shallow.push(rest);
    else if (verb === 'deepen') deepen = parseInt(rest, 10);
    else if (verb === 'deepen-not') deepenNot.push(rest);
    // done: ignored
  }
  if (!wants.length) {
    send(res, 400, 'text/plain', Buffer.from('no wants'));
    return true;
  }
  const plan = planFetch(repo, wants, haves, shallow, deepen, deepenNot);
  const pack = writePack(plan.packObjects);
  const parts: Buffer[] = [];
  if (plan.nak) parts.push(encodePktLine('NAK\n'));
  else for (const a of plan.acks) parts.push(encodePktLine(`ACK ${a}\n`));
  for (const s of plan.shallow) parts.push(encodePktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(encodePktLine(`unshallow ${s}\n`));
  parts.push(sidebandPack(pack));
  parts.push(PKT_FLUSH);
  send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
  return true;
}

export async function handleReceivePack(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string): Promise<boolean> {
  if (!authed(req)) { send(res, 401, 'application/json', Buffer.from(JSON.stringify({ message: 'authentication required' }))); return true; }
  const repo = resolveRepo(owner, repoName);
  if (!repo) { send(res, 404, 'application/json', Buffer.from(JSON.stringify({ message: 'repository not found' }))); return true; }
  const body = await readBody(req);
  let parsed: { lines: Buffer[]; offset: number; flushed: boolean };
  try {
    parsed = readPktLines(body);
  } catch {
    send(res, 400, 'text/plain', Buffer.from('malformed pkt-line stream'));
    return true;
  }
  if (!parsed.flushed || !parsed.lines.length) {
    send(res, 400, 'text/plain', Buffer.from('no commands'));
    return true;
  }
  interface Cmd { old: string; nw: string; ref: string }
  const cmds: Cmd[] = [];
  for (const raw of parsed.lines) {
    let s = lineStr(raw);
    const nul = s.indexOf('\0');
    if (nul >= 0) s = s.slice(0, nul); // capabilities on first line
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(s);
    if (!m) {
      send(res, 400, 'text/plain', Buffer.from('bad command line'));
      return true;
    }
    cmds.push({ old: m[1], nw: m[2], ref: m[3] });
  }
  const packBytes = body.subarray(parsed.offset);
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let unpackOk = true;
  if (packBytes.length > 0) {
    try {
      const pack = readPack(packBytes);
      for (const [oid, obj] of pack.objects) {
        if (!repo.hasObject(oid)) repo.objects.set(oid, obj);
      }
    } catch {
      unpackOk = false;
    }
  }
  for (const cmd of cmds) {
    if (!unpackOk) { results.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' }); continue; }
    if (!cmd.ref.startsWith('refs/heads/') && !cmd.ref.startsWith('refs/tags/')) {
      results.push({ ref: cmd.ref, ok: false, reason: 'invalid ref' });
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.nw === ZERO_OID) {
      // delete
      if (!current) results.push({ ref: cmd.ref, ok: false, reason: 'ref does not exist' });
      else if (cmd.old !== ZERO_OID && cmd.old !== current) results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      else { repo.refs.delete(cmd.ref); results.push({ ref: cmd.ref, ok: true, reason: '' }); }
      continue;
    }
    if (!repo.hasObject(cmd.nw)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (cmd.old === ZERO_OID) {
      // create
      if (current) results.push({ ref: cmd.ref, ok: false, reason: 'already exists' });
      else { repo.refs.set(cmd.ref, cmd.nw); results.push({ ref: cmd.ref, ok: true, reason: '' }); }
      continue;
    }
    // update
    if (!current) results.push({ ref: cmd.ref, ok: false, reason: 'ref does not exist' });
    else if (cmd.old !== current) results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
    else if (!repo.isAncestor(cmd.old, cmd.nw)) results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
    else { repo.refs.set(cmd.ref, cmd.nw); results.push({ ref: cmd.ref, ok: true, reason: '' }); }
  }
  const inner: Buffer[] = [encodePktLine(unpackOk ? 'unpack ok\n' : 'unpack failed\n')];
  for (const r of results) {
    inner.push(encodePktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`));
  }
  const out = Buffer.concat([sidebandPack(Buffer.concat(inner)), PKT_FLUSH]);
  send(res, 200, 'application/x-git-receive-pack-result', out);
  return true;
}
