// ---------------------------------------------------------------------------
// store.ts — in-memory forge state: repos, git objects/refs, issues, PRs.
// Single process, deterministic: fixed identity/timestamps, sequential ids.
// ---------------------------------------------------------------------------
import {
  ZERO_OID, hashObject, parseCommit, parseTree, buildTree, buildCommit,
  type GitObject, type GitObjectType, type TreeEntry,
} from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const DEFAULT_BRANCH = 'main';
export const FIXED_ISO = '2025-01-01T00:00:00Z';

export function globalId(kind: string, id: number | string): string {
  return Buffer.from(`${kind}:${id}`).toString('base64');
}

// ---------------------------------------------------------------------------
// ResponseCache — bounded FIFO cache of pre-built git-protocol response
// Buffers, scoped per Repo (held on the Repo so it dies with the repo and
// can never leak across stores). Entries are only ever stored for inputs
// whose output is a pure function of immutable state (see gitproto.ts):
//   advertisement / ls-refs  -> keyed by refsVersion (bumped on every refs
//     mutation) + immutable tag objects; defaultBranch never changes.
//   fetch packfile          -> keyed by wants/haves/shallow/deepen/deepenNot
//     + objects.size (objects are append-only, so any object-set change
//     changes the size and the key). Deterministic: same key, same bytes.
// Caps keep memory bounded; eviction is FIFO (oldest first).
// ---------------------------------------------------------------------------
export class ResponseCache {
  private static readonly MAX_ENTRIES = 256;
  private static readonly MAX_BYTES = 8 * 1024 * 1024;
  private map = new Map<string, Buffer>();
  private bytes = 0;

  get(key: string): Buffer | undefined { return this.map.get(key); }

  set(key: string, value: Buffer): void {
    if (this.map.has(key)) return; // already cached; value is deterministic
    while ((this.map.size >= ResponseCache.MAX_ENTRIES || this.bytes + value.length > ResponseCache.MAX_BYTES) && this.map.size > 0) {
      const oldest = this.map.keys().next().value!;
      this.bytes -= this.map.get(oldest)!.length;
      this.map.delete(oldest);
    }
    this.map.set(key, value);
    this.bytes += value.length;
  }
}

export interface Label { name: string; color: string }
export interface Comment { id: number; body: string }
export interface Issue {
  number: number; title: string; body: string;
  state: 'open' | 'closed'; labels: string[]; seq: number;
  comments: Comment[];
}
export interface PullFile {
  filename: string; status: 'added' | 'modified' | 'removed';
  additions: number; deletions: number; changes: number;
}
export interface Pull {
  number: number; title: string; body: string;
  state: 'open' | 'closed'; merged: boolean;
  merged_at: string | null; merge_commit_sha: string | null;
  headRef: string; baseRef: string; headSha: string; baseSha: string;
  baseCommitOid: string; // merge-base at creation (base tip then)
  files: PullFile[];
}

export class Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string = VIEWER_LOGIN;
  description: string;
  private: boolean;
  defaultBranch: string = DEFAULT_BRANCH;
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>(); // full refname -> oid
  issues: Issue[] = [];
  issueSeq = 0;
  commentSeq = 0;
  labels = new Map<string, Label>();
  pulls: Pull[] = [];
  pullSeq = 0;
  seq = 0; // creation order (pagination)
  refsVersion = 0; // bumped on every refs mutation; invalidates adv/ls-refs cache
  gitCache = new ResponseCache(); // pre-built git-protocol responses (see ResponseCache)

  constructor(id: number, name: string, description: string, isPrivate: boolean) {
    this.id = id; this.name = name;
    this.description = description; this.private = isPrivate;
  }

  // -- git objects ---------------------------------------------------------
  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }
  getObject(oid: string): GitObject | undefined { return this.objects.get(oid); }
  hasObject(oid: string): boolean { return this.objects.has(oid); }

  refTip(ref: string): string | undefined { return this.refs.get(ref); }
  branchTip(branch: string): string | undefined { return this.refs.get(`refs/heads/${branch}`); }
  setBranch(branch: string, oid: string): void { this.refs.set(`refs/heads/${branch}`, oid); this.touchRefs(); }
  touchRefs(): void { this.refsVersion++; }

  branches(): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of this.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  // Walk commit history newest-first (DFS following parents in order).
  commitHistory(tip: string, limit = 10000): Array<{ sha: string; message: string }> {
    const out: Array<{ sha: string; message: string }> = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length && out.length < limit) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const c = parseCommit(obj.data);
      out.push({ sha: oid, message: c.message });
      for (let i = c.parents.length - 1; i >= 0; i--) stack.push(c.parents[i]);
    }
    return out;
  }

  isAncestor(ancestor: string, oid: string): boolean {
    if (ancestor === oid) return true;
    const seen = new Set<string>();
    const stack = [oid];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === ancestor) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = this.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
    return false;
  }

  mergeBase(a: string, b: string): string | null {
    const ancA = new Set<string>();
    const stack = [a];
    while (stack.length) {
      const cur = stack.pop()!;
      if (ancA.has(cur)) continue;
      ancA.add(cur);
      const obj = this.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
    const stackB = [b];
    const seenB = new Set<string>();
    while (stackB.length) {
      const cur = stackB.pop()!;
      if (ancA.has(cur)) return cur;
      if (seenB.has(cur)) continue;
      seenB.add(cur);
      const obj = this.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) stackB.push(p);
    }
    return null;
  }

  // Flatten a tree (commit oid or tree oid) to path -> {mode, oid}.
  flattenTree(rootOid: string): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    let treeOid = rootOid;
    const root = this.objects.get(rootOid);
    if (root?.type === 'commit') treeOid = parseCommit(root.data).tree;
    const walk = (tid: string, prefix: string): void => {
      const obj = this.objects.get(tid);
      if (!obj || obj.type !== 'tree') return;
      for (const e of parseTree(obj.data)) {
        const path = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.mode === '40000') walk(e.oid, path);
        else out.set(path, { mode: e.mode, oid: e.oid });
      }
    };
    walk(treeOid, '');
    return out;
  }

  // Build a tree object from a flat path map; returns the tree oid.
  buildTreeFromFlat(flat: Map<string, { mode: string; oid: string }>): string {
    const byDir = new Map<string, TreeEntry[]>();
    const getDir = (dir: string): TreeEntry[] => {
      let arr = byDir.get(dir);
      if (!arr) { arr = []; byDir.set(dir, arr); }
      return arr;
    };
    for (const [path, v] of flat) {
      const slash = path.lastIndexOf('/');
      const dir = slash < 0 ? '' : path.slice(0, slash);
      const name = slash < 0 ? path : path.slice(slash + 1);
      getDir(dir).push({ mode: v.mode, name, oid: v.oid });
    }
    // Build bottom-up: deepest dirs first. Every ancestor dir (incl. root '')
    // must exist so nested files are reachable from the root tree.
    const allDirs = new Set<string>(['']);
    for (const dir of [...byDir.keys()]) {
      const parts = dir.split('/');
      for (let i = 1; i <= parts.length; i++) allDirs.add(parts.slice(0, i).join('/'));
    }
    const depth = (d: string): number => (d === '' ? 0 : d.split('/').length);
    const dirs = [...allDirs].sort((a, b) => depth(b) - depth(a));
    const treeOid = new Map<string, string>();
    for (const dir of dirs) {
      const entries = [...(byDir.get(dir) ?? [])];
      for (const sub of allDirs) {
        if (sub === dir) continue;
        const slash = sub.lastIndexOf('/');
        const parent = slash < 0 ? '' : sub.slice(0, slash);
        if (parent === dir) {
          const oid = treeOid.get(sub);
          if (oid) entries.push({ mode: '40000', name: sub.slice(slash + 1), oid });
        }
      }
      const oid = this.putObject('tree', buildTree(entries));
      treeOid.set(dir, oid);
    }
    return treeOid.get('') ?? this.putObject('tree', buildTree([]));
  }

  // Diff two commit oids (or tree oids) -> file list.
  diffFiles(baseOid: string, headOid: string): PullFile[] {
    const base = this.flattenTree(baseOid);
    const head = this.flattenTree(headOid);
    const files: PullFile[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && h && b.oid === h.oid) continue;
      const countLines = (oid: string): number => {
        const obj = this.objects.get(oid);
        if (!obj) return 0;
        const s = obj.data.toString('utf8');
        return s.length === 0 ? 0 : s.split('\n').length - (s.endsWith('\n') ? 1 : 0);
      };
      if (!b && h) {
        const add = countLines(h.oid);
        files.push({ filename: path, status: 'added', additions: Math.max(add, 1), deletions: 0, changes: Math.max(add, 1) });
      } else if (b && !h) {
        const del = countLines(b.oid);
        files.push({ filename: path, status: 'removed', additions: 0, deletions: Math.max(del, 1), changes: Math.max(del, 1) });
      } else if (b && h) {
        const add = countLines(h.oid);
        const del = countLines(b.oid);
        files.push({ filename: path, status: 'modified', additions: Math.max(add, 1), deletions: del, changes: Math.max(add, 1) + del });
      }
    }
    files.sort((a, b) => (a.filename < b.filename ? -1 : 1));
    return files;
  }

  // Create a commit on `branch` applying flat-tree changes (path -> blob oid | null delete).
  // Returns the new commit oid. `message` is the commit message.
  commitOnBranch(branch: string, message: string, changes: Map<string, { mode: string; oid: string } | null>): string {
    const tip = this.branchTip(branch);
    let flat = new Map<string, { mode: string; oid: string }>();
    if (tip) {
      const c = parseCommit(this.objects.get(tip)!.data);
      flat = this.flattenTree(c.tree);
    }
    for (const [path, v] of changes) {
      if (v === null) flat.delete(path);
      else flat.set(path, v);
    }
    const treeOid = this.buildTreeFromFlat(flat);
    const parents = tip ? [tip] : [];
    const commitOid = this.putObject('commit', buildCommit(treeOid, parents, message));
    this.setBranch(branch, commitOid);
    return commitOid;
  }

  // File blob at a path on a branch (or at a commit oid). Returns {blobOid, content} or null.
  readFile(branchOrCommit: string, path: string): { blobOid: string; content: Buffer } | null {
    let tip = this.branchTip(branchOrCommit);
    if (!tip) tip = branchOrCommit; // maybe a commit oid
    const obj = this.objects.get(tip);
    if (!obj || obj.type !== 'commit') return null;
    const flat = this.flattenTree(tip);
    const entry = flat.get(path);
    if (!entry) return null;
    const blob = this.objects.get(entry.oid);
    if (!blob) return null;
    return { blobOid: entry.oid, content: blob.data };
  }

  // Directory listing at a path on a branch. Returns null if path is not a dir.
  listDir(branchOrCommit: string, path: string): Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> | null {
    let tip = this.branchTip(branchOrCommit);
    if (!tip) tip = branchOrCommit;
    const obj = this.objects.get(tip);
    if (!obj || obj.type !== 'commit') return null;
    const treeOid = parseCommit(obj.data).tree;
    let dirOid = treeOid;
    if (path) {
      const parts = path.split('/');
      let cur = treeOid;
      for (const part of parts) {
        const curObj = this.objects.get(cur);
        if (!curObj || curObj.type !== 'tree') return null;
        const found = parseTree(curObj.data).find((e) => e.name === part && e.mode === '40000');
        if (!found) return null;
        cur = found.oid;
      }
      dirOid = cur;
    }
    const dirObj = this.objects.get(dirOid);
    if (!dirObj || dirObj.type !== 'tree') return null;
    return parseTree(dirObj.data).map((e) => ({
      type: (e.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
      name: e.name,
      path: path ? `${path}/${e.name}` : e.name,
      sha: e.oid,
    }));
  }

  // -- issues / pulls -------------------------------------------------------
  createIssue(title: string, body: string, labels: string[]): Issue {
    const issue: Issue = {
      number: ++this.issueSeq, title, body, state: 'open',
      labels: [...labels], seq: this.issues.length, comments: [],
    };
    this.issues.push(issue);
    return issue;
  }

  createPull(title: string, body: string, headRef: string, baseRef: string): Pull | null {
    const headSha = this.branchTip(headRef);
    const baseSha = this.branchTip(baseRef);
    if (!headSha || !baseSha) return null;
    const base = this.mergeBase(headSha, baseSha) ?? baseSha;
    const files = this.diffFiles(base, headSha);
    const pull: Pull = {
      number: ++this.pullSeq, title, body, state: 'open', merged: false,
      merged_at: null, merge_commit_sha: null,
      headRef, baseRef, headSha, baseSha, baseCommitOid: base, files,
    };
    this.pulls.push(pull);
    return pull;
  }

  // 3-way conflict check for a PR against the CURRENT base tip.
  pullMergeable(pull: Pull): boolean {
    const baseTip = this.branchTip(pull.baseRef);
    const headTip = this.branchTip(pull.headRef);
    if (!baseTip || !headTip) return false;
    const base = this.mergeBase(headTip, baseTip);
    if (!base) return false;
    const baseFlat = this.flattenTree(base);
    const headFlat = this.flattenTree(headTip);
    const curFlat = this.flattenTree(baseTip);
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of paths) {
      const b = baseFlat.get(path)?.oid;
      const h = headFlat.get(path)?.oid;
      if (b === h) continue; // unchanged in PR
      const c = curFlat.get(path)?.oid;
      if (c !== b && c !== h) return false; // both sides changed differently
    }
    return true;
  }

  // Squash-merge a PR onto its base branch. Returns merge commit oid or null on conflict.
  mergePull(pull: Pull): string | null {
    if (pull.state !== 'open' || pull.merged) return null;
    if (!this.pullMergeable(pull)) return null;
    const baseTip = this.branchTip(pull.baseRef)!;
    const headTip = this.branchTip(pull.headRef)!;
    const base = this.mergeBase(headTip, baseTip) ?? pull.baseCommitOid;
    const baseFlat = this.flattenTree(base);
    const headFlat = this.flattenTree(headTip);
    const curFlat = this.flattenTree(baseTip);
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of paths) {
      const b = baseFlat.get(path)?.oid;
      const h = headFlat.get(path);
      if (b === h?.oid) continue;
      if (h) curFlat.set(path, h);
      else curFlat.delete(path);
    }
    const treeOid = this.buildTreeFromFlat(curFlat);
    const mergeOid = this.putObject('commit', buildCommit(treeOid, [baseTip], `Merge pull request #${pull.number}`));
    this.setBranch(pull.baseRef, mergeOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = FIXED_ISO;
    pull.merge_commit_sha = mergeOid;
    return mergeOid;
  }
}

export class Store {
  repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextSeq = 0;

  key(owner: string, name: string): string { return `${owner}/${name}`; }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    const key = this.key(VIEWER_LOGIN, name);
    if (this.repos.has(key)) return null;
    const repo = new Repo(this.nextRepoId++, name, description, isPrivate);
    repo.seq = this.nextSeq++;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER_LOGIN) return undefined;
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER_LOGIN) return false;
    return this.repos.delete(this.key(owner, name));
  }

  listViewerRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }
}

export const store = new Store();
