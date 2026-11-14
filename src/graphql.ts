// ---------------------------------------------------------------------------
// graphql.ts — GitHub GraphQL v4 surface (M3).
// Small hand-rolled executor for the documented subset (spec/rest-graphql-spec.md
// §4): Query.viewer/repository/node/__type, Repository/Issue/PullRequest fields,
// issues/pullRequests/files connections + cursor pagination, 5 mutations.
// Two opposite error models, both required:
//   - unknown repository -> HTTP 200, data.repository = null, errors []
//   - unknown field      -> HTTP 200, errors[] whose message names the field
// No token -> 401. Batch: JSON array body -> JSON array response, same order.
// ---------------------------------------------------------------------------
import { store, globalId, VIEWER_LOGIN, type Repo, type Issue, type Pull } from './store.ts';
import { readBody, authed } from './gitproto.ts';
import { sendJson } from '../app.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Tokenizer + parser (GraphQL query-language subset)
// ---------------------------------------------------------------------------

type TokKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';
interface Tok { kind: TokKind; value: string; line: number; col: number }

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const push = (kind: TokKind, value: string, l: number, c: number): void => { toks.push({ kind, value, line: l, col: c }); };
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '\n') { i++; line++; col = 1; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === ',' || ch === '﻿') { i++; col++; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') { i++; col++; } continue; }
    if (ch === '.' && src.slice(i, i + 3) === '...') { push('spread', '...', line, col); i += 3; col += 3; continue; }
    if ('!$():=@[]{}|&'.includes(ch)) { push('punct', ch, line, col); i++; col++; continue; }
    if (ch === '"') {
      // Block string """...""" (tolerated) or regular "..." with escapes.
      if (src.slice(i, i + 3) === '"""') {
        const end = src.indexOf('"""', i + 3);
        if (end < 0) throw new Error(`unterminated block string at line ${line}`);
        push('string', src.slice(i + 3, end), line, col);
        const seg = src.slice(i, end + 3);
        const nl = (seg.match(/\n/g) ?? []).length;
        line += nl;
        col = nl ? seg.length - seg.lastIndexOf('\n') : col + seg.length;
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1]!;
          if (e === 'u' && j + 5 < src.length) { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 6; continue; }
          out += { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f' }[e] ?? e;
          j += 2;
          continue;
        }
        out += src[j]!;
        j++;
      }
      if (j >= src.length) throw new Error(`unterminated string at line ${line}`);
      push('string', out, line, col);
      col += j - i + 1;
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      if (src[j] === '-') j++;
      while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      let isFloat = false;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        isFloat = true;
        j++;
        while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      }
      push(isFloat ? 'float' : 'int', src.slice(i, j), line, col);
      col += j - i;
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[_A-Za-z0-9]/.test(src[j]!)) j++;
      push('name', src.slice(i, j), line, col);
      col += j - i;
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at line ${line} col ${col}`);
  }
  toks.push({ kind: 'eof', value: '', line, col });
  return toks;
}

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'string'; v: string }
  | { kind: 'int'; v: number }
  | { kind: 'float'; v: number }
  | { kind: 'bool'; v: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; v: string }
  | { kind: 'list'; v: ValueNode[] }
  | { kind: 'object'; v: Array<{ name: string; value: ValueNode }> };

interface ArgNode { name: string; value: ValueNode }
type SelectionNode =
  | { kind: 'field'; alias?: string; name: string; args: ArgNode[]; sel?: SelectionNode[]; line: number; col: number }
  | { kind: 'fragment'; typeCond?: string; sel: SelectionNode[] };
interface VarDef { name: string }
interface Operation { kind: 'query' | 'mutation'; name?: string; vars: VarDef[]; sel: SelectionNode[] }

class Parser {
  private pos = 0;
  private toks: Tok[];
  constructor(toks: Tok[]) { this.toks = toks; }

  private peek(): Tok { return this.toks[this.pos]!; }
  private next(): Tok { return this.toks[this.pos++]!; }
  private atPunct(v: string): boolean { const t = this.peek(); return t.kind === 'punct' && t.value === v; }
  private eatPunct(v: string): boolean { if (this.atPunct(v)) { this.pos++; return true; } return false; }
  private expectPunct(v: string): Tok {
    if (!this.eatPunct(v)) { const t = this.peek(); throw new Error(`expected '${v}' but got '${t.value}' at line ${t.line}`); }
    return this.toks[this.pos - 1]!;
  }
  private expectName(what = 'name'): Tok {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected ${what} but got '${t.value}' at line ${t.line}`);
    return t;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.peek().kind !== 'eof') ops.push(this.parseOperation());
    return ops;
  }

  private parseOperation(): Operation {
    const t = this.peek();
    if (this.atPunct('{')) {
      return { kind: 'query', vars: [], sel: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      this.next();
      const kind = t.value as 'query' | 'mutation';
      let name: string | undefined;
      if (this.peek().kind === 'name') name = this.next().value;
      const vars = this.atPunct('(') ? this.parseVarDefs() : [];
      return { kind, name, vars, sel: this.parseSelectionSet() };
    }
    throw new Error(`expected operation but got '${t.value}' at line ${t.line}`);
  }

  private parseVarDefs(): VarDef[] {
    this.expectPunct('(');
    const defs: VarDef[] = [];
    while (!this.atPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName('variable').value;
      this.expectPunct(':');
      this.parseType();
      if (this.eatPunct('=')) this.parseValue();
      defs.push({ name });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseType(): void {
    if (this.eatPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('type');
    }
    this.eatPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const sels: SelectionNode[] = [];
    while (!this.atPunct('}')) sels.push(this.parseSelection());
    this.expectPunct('}');
    return sels;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'spread') {
      this.next();
      let typeCond: string | undefined;
      const t = this.peek();
      if (t.kind === 'name' && t.value === 'on') {
        this.next();
        typeCond = this.expectName('type condition').value;
      } else if (this.peek().kind === 'name') {
        throw new Error('named fragment spreads are not supported');
      }
      return { kind: 'fragment', typeCond, sel: this.parseSelectionSet() };
    }
    const first = this.expectName('field');
    let alias: string | undefined;
    let name = first.value;
    if (this.atPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName('field').value;
    }
    // Directives (e.g. @include) are not used by the suite; skip them.
    while (this.atPunct('@')) {
      this.next();
      this.expectName('directive');
      if (this.atPunct('(')) {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const tk = this.next();
          if (tk.kind === 'punct' && tk.value === '(') depth++;
          if (tk.kind === 'punct' && tk.value === ')') depth--;
          if (tk.kind === 'eof') throw new Error('unterminated directive arguments');
        }
      }
    }
    const args = this.atPunct('(') ? this.parseArguments() : [];
    const sel = this.atPunct('{') ? this.parseSelectionSet() : undefined;
    return { kind: 'field', alias, name, args, sel, line: first.line, col: first.col };
  }

  private parseArguments(): ArgNode[] {
    this.expectPunct('(');
    const args: ArgNode[] = [];
    while (!this.atPunct(')')) {
      const name = this.expectName('argument').value;
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'var', name: this.expectName('variable').value };
    if (t.kind === 'string') return { kind: 'string', v: t.value };
    if (t.kind === 'int') return { kind: 'int', v: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', v: parseFloat(t.value) };
    if (t.kind === 'punct' && t.value === '[') {
      const items: ValueNode[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', v: items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.atPunct('}')) {
        const name = this.expectName('object field').value;
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', v: fields };
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'bool', v: true };
      if (t.value === 'false') return { kind: 'bool', v: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', v: t.value };
    }
    throw new Error(`unexpected value token '${t.value}' at line ${t.line}`);
  }
}

type Vars = Record<string, unknown>;

function valueToJs(v: ValueNode, vars: Vars): unknown {
  switch (v.kind) {
    case 'var': return vars[v.name];
    case 'string': case 'int': case 'float': case 'bool': return v.v;
    case 'null': return null;
    case 'enum': return v.v;
    case 'list': return v.v.map((x) => valueToJs(x, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of v.v) out[f.name] = valueToJs(f.value, vars);
      return out;
    }
  }
}

function resolveArgs(args: ArgNode[], vars: Vars): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of args) out[a.name] = valueToJs(a.value, vars);
  return out;
}

// ---------------------------------------------------------------------------
// Schema + resolvers
// ---------------------------------------------------------------------------

interface Ctx { errors: Array<Record<string, unknown>> }
type Resolver = (parent: any, args: Record<string, unknown>, ctx: Ctx) => unknown;
interface FieldDef { type: string; resolve: Resolver }
type SchemaTable = Record<string, Record<string, FieldDef>>;

function findRepoById(id: number): Repo | undefined {
  for (const r of store.listViewerRepos()) if (r.id === id) return r;
  return undefined;
}

function decodeGlobalId(gid: unknown): { kind: string; rest: string } | null {
  if (typeof gid !== 'string' || !gid) return null;
  try {
    const s = Buffer.from(gid, 'base64').toString('utf8');
    const i = s.indexOf(':');
    if (i < 0) return null;
    return { kind: s.slice(0, i), rest: s.slice(i + 1) };
  } catch {
    return null;
  }
}

function repoOfIssue(issue: Issue & { __repoId?: number }): Repo | undefined {
  return issue.__repoId !== undefined ? findRepoById(issue.__repoId) : undefined;
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('issue', `${repo.id}:${issue.number}`);
}
function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('pr', `${repo.id}:${pull.number}`);
}

function tagIssue(repo: Repo, issue: Issue): Issue & { __repoId: number } {
  (issue as Issue & { __repoId?: number }).__repoId = repo.id;
  return issue as Issue & { __repoId: number };
}
function tagPull(repo: Repo, pull: Pull): Pull & { __repoId: number } {
  (pull as Pull & { __repoId?: number }).__repoId = repo.id;
  return pull as Pull & { __repoId: number };
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`).toString('base64');
}
function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || !cursor) return null;
  try {
    const s = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(s);
    return m ? parseInt(m[1]!, 10) : null;
  } catch {
    return null;
  }
}

function pageInfoFor<T>(items: T[], start: number, slice: T[]): Record<string, unknown> {
  return {
    __typename: 'PageInfo',
    hasNextPage: start + slice.length < items.length,
    hasPreviousPage: start > 0,
    startCursor: slice.length ? encodeCursor(start) : null,
    endCursor: slice.length ? encodeCursor(start + slice.length - 1) : null,
  };
}

function paginate<T>(items: T[], args: Record<string, unknown>): Record<string, unknown> {
  const first = typeof args.first === 'number' ? Math.max(0, args.first) : items.length;
  let start = 0;
  if (typeof args.after === 'string' && args.after) {
    const idx = decodeCursor(args.after);
    if (idx !== null) start = idx + 1;
  }
  const slice = items.slice(start, start + first);
  return { nodes: slice, pageInfo: pageInfoFor(items, start, slice) };
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let items = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    items = items.filter((i) => wanted.has(i.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  if (orderBy?.field) {
    const dir = orderBy.direction === 'ASC' ? 1 : -1;
    const key = (i: Issue): number => (orderBy.field === 'COMMENTS' ? i.comments.length : i.seq);
    items.sort((a, b) => (key(a) - key(b)) * dir);
  } else {
    items.sort((a, b) => a.seq - b.seq);
  }
  const conn = paginate(items, args) as { nodes: Issue[]; pageInfo: Record<string, unknown> };
  return {
    __typename: 'IssueConnection',
    nodes: conn.nodes.map((i) => tagIssue(repo, i)),
    pageInfo: conn.pageInfo,
    totalCount: items.length,
  };
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  const items = [...repo.pulls].sort((a, b) => a.number - b.number);
  const conn = paginate(items, args) as { nodes: Pull[]; pageInfo: Record<string, unknown> };
  return {
    __typename: 'PullRequestConnection',
    nodes: conn.nodes.map((p) => tagPull(repo, p)),
    pageInfo: conn.pageInfo,
    totalCount: items.length,
  };
}

function filesConnection(pull: Pull, args: Record<string, unknown>): Record<string, unknown> {
  const nodes = pull.files.map((f) => ({
    __typename: 'PullRequestChangedFile',
    path: f.filename,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
    status: f.status === 'removed' ? 'REMOVED' : f.status === 'added' ? 'ADDED' : 'MODIFIED',
  }));
  const conn = paginate(nodes, args) as { nodes: unknown[]; pageInfo: Record<string, unknown> };
  return { __typename: 'PullRequestChangedFileConnection', nodes: conn.nodes, pageInfo: conn.pageInfo, totalCount: nodes.length };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}
function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

const userObject = (): Record<string, unknown> => ({ __typename: 'User', login: VIEWER_LOGIN });

// Introspection tables: fields / enum values the suite may ask for.
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'comments', 'labels', 'createdAt', 'updatedAt', 'url', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'headRef', 'baseRef', 'mergedAt', 'mergeCommit', 'author', 'createdAt', 'updatedAt', 'url', 'repository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url'],
  User: ['id', 'login', 'name', 'avatarUrl', 'url'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes', 'status'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
};
const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

function introspectType(name: string): Record<string, unknown> | null {
  if (TYPE_FIELDS[name]) {
    return {
      __typename: '__Type',
      name,
      kind: 'OBJECT',
      description: null,
      fields: TYPE_FIELDS[name]!.map((f) => ({ __typename: '__Field', name: f, description: null, args: [] })),
      enumValues: null,
    };
  }
  if (TYPE_ENUMS[name]) {
    return {
      __typename: '__Type',
      name,
      kind: 'ENUM',
      description: null,
      fields: null,
      enumValues: TYPE_ENUMS[name]!.map((v) => ({ __typename: '__EnumValue', name: v, description: null })),
    };
  }
  return null;
}

// -- mutation helpers ---------------------------------------------------------

function repoFromGlobalId(gid: unknown): Repo | null {
  const dec = decodeGlobalId(gid);
  if (!dec || dec.kind !== 'repo') return null;
  const id = Number(dec.rest);
  if (!Number.isFinite(id)) return null;
  return findRepoById(id) ?? null;
}

function issueFromGlobalId(gid: unknown): { repo: Repo; issue: Issue } | null {
  const dec = decodeGlobalId(gid);
  if (!dec || dec.kind !== 'issue') return null;
  const [repoId, num] = dec.rest.split(':');
  const repo = findRepoById(Number(repoId));
  if (!repo) return null;
  const issue = repo.issues.find((i) => i.number === Number(num));
  return issue ? { repo, issue } : null;
}

function pullFromGlobalId(gid: unknown): { repo: Repo; pull: Pull } | null {
  const dec = decodeGlobalId(gid);
  if (!dec || dec.kind !== 'pr') return null;
  const [repoId, num] = dec.rest.split(':');
  const repo = findRepoById(Number(repoId));
  if (!repo) return null;
  const pull = repo.pulls.find((p) => p.number === Number(num));
  return pull ? { repo, pull } : null;
}

// -- schema -------------------------------------------------------------------

const SCHEMA: SchemaTable = {
  Query: {
    viewer: { type: 'User', resolve: () => userObject() },
    repository: {
      type: 'Repository',
      resolve: (_p, args) => {
        const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ?? null;
      },
    },
    node: {
      type: 'Node',
      resolve: (_p, args) => {
        const dec = decodeGlobalId(args.id);
        if (!dec) return null;
        if (dec.kind === 'repo') {
          const repo = findRepoById(Number(dec.rest));
          if (!repo) return null;
          (repo as Repo & { __typename?: string }).__typename = 'Repository';
          return repo;
        }
        if (dec.kind === 'issue') {
          const found = issueFromGlobalId(args.id);
          if (!found) return null;
          const issue = tagIssue(found.repo, found.issue);
          (issue as Issue & { __typename?: string }).__typename = 'Issue';
          return issue;
        }
        if (dec.kind === 'pr') {
          const found = pullFromGlobalId(args.id);
          if (!found) return null;
          const pull = tagPull(found.repo, found.pull);
          (pull as Pull & { __typename?: string }).__typename = 'PullRequest';
          return pull;
        }
        return null;
      },
    },
    __type: {
      type: '__Type',
      resolve: (_p, args) => introspectType(String(args.name ?? '')),
    },
  },
  Mutation: {
    createIssue: {
      type: 'CreateIssuePayload',
      resolve: (_p, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoFromGlobalId(input.repositoryId);
        if (!repo) throw new Error('repository not found');
        const issue = tagIssue(repo, repo.createIssue(String(input.title ?? ''), String(input.body ?? ''), []));
        return { __typename: 'CreateIssuePayload', issue };
      },
    },
    closeIssue: {
      type: 'CloseIssuePayload',
      resolve: (_p, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueFromGlobalId(input.issueId);
        if (!found) throw new Error('issue not found');
        found.issue.state = 'closed';
        return { __typename: 'CloseIssuePayload', issue: tagIssue(found.repo, found.issue) };
      },
    },
    createPullRequest: {
      type: 'PullRequestCreatePayload',
      resolve: (_p, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoFromGlobalId(input.repositoryId);
        if (!repo) throw new Error('repository not found');
        const pull = repo.createPull(
          String(input.title ?? ''),
          '',
          String(input.headRefName ?? ''),
          String(input.baseRefName ?? repo.defaultBranch),
        );
        if (!pull) throw new Error('head or base branch not found');
        return { __typename: 'PullRequestCreatePayload', pullRequest: tagPull(repo, pull) };
      },
    },
    mergePullRequest: {
      type: 'MergePullRequestPayload',
      resolve: (_p, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = pullFromGlobalId(input.pullRequestId);
        if (!found) throw new Error('pull request not found');
        found.repo.mergePull(found.pull);
        return { __typename: 'MergePullRequestPayload', pullRequest: tagPull(found.repo, found.pull) };
      },
    },
    addComment: {
      type: 'AddCommentPayload',
      resolve: (_p, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueFromGlobalId(input.subjectId);
        if (!found) throw new Error('subject not found');
        const comment = { id: ++found.repo.commentSeq, body: String(input.body ?? '') };
        found.issue.comments.push(comment);
        return {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'CommentEdge',
            node: {
              __typename: 'IssueComment',
              id: globalId('comment', `${found.repo.id}:${found.issue.number}:${comment.id}`),
              body: comment.body,
            },
          },
        };
      },
    },
  },
  User: {
    id: { type: 'ID', resolve: () => globalId('user', 1000) },
    login: { type: 'String', resolve: (p) => (p as { login: string }).login },
    name: { type: 'String', resolve: () => VIEWER_LOGIN },
    avatarUrl: { type: 'String', resolve: () => null },
    url: { type: 'String', resolve: () => null },
  },
  Repository: {
    id: { type: 'ID', resolve: (p) => globalId('repo', (p as Repo).id) },
    databaseId: { type: 'Int', resolve: (p) => (p as Repo).id },
    name: { type: 'String', resolve: (p) => (p as Repo).name },
    nameWithOwner: { type: 'String', resolve: (p) => `${(p as Repo).owner}/${(p as Repo).name}` },
    owner: { type: 'User', resolve: () => userObject() },
    defaultBranchRef: {
      type: 'Ref',
      resolve: (p) => {
        const repo = p as Repo;
        return repo.branchTip(repo.defaultBranch)
          ? { __typename: 'Ref', name: repo.defaultBranch }
          : null;
      },
    },
    viewerPermission: { type: 'RepositoryPermission', resolve: () => 'ADMIN' },
    hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
    description: { type: 'String', resolve: (p) => (p as Repo).description },
    isPrivate: { type: 'Boolean', resolve: (p) => (p as Repo).private },
    createdAt: { type: 'String', resolve: () => '2025-01-01T00:00:00Z' },
    updatedAt: { type: 'String', resolve: () => '2025-01-01T00:00:00Z' },
    url: { type: 'String', resolve: () => null },
    issue: {
      type: 'Issue',
      resolve: (p, args) => {
        const repo = p as Repo;
        const issue = repo.issues.find((i) => i.number === Number(args.number));
        return issue ? tagIssue(repo, issue) : null;
      },
    },
    issues: { type: 'IssueConnection', resolve: (p, args) => issuesConnection(p as Repo, args) },
    pullRequests: { type: 'PullRequestConnection', resolve: (p, args) => pullsConnection(p as Repo, args) },
    pullRequest: {
      type: 'PullRequest',
      resolve: (p, args) => {
        const repo = p as Repo;
        const pull = repo.pulls.find((x) => x.number === Number(args.number));
        return pull ? tagPull(repo, pull) : null;
      },
    },
  },
  Ref: {
    name: { type: 'String', resolve: (p) => (p as { name: string }).name },
  },
  Issue: {
    id: {
      type: 'ID',
      resolve: (p) => {
        const issue = p as Issue & { __repoId?: number };
        const repo = repoOfIssue(issue);
        return repo ? issueGlobalId(repo, issue) : globalId('issue', `?:${issue.number}`);
      },
    },
    number: { type: 'Int', resolve: (p) => (p as Issue).number },
    title: { type: 'String', resolve: (p) => (p as Issue).title },
    state: { type: 'IssueState', resolve: (p) => issueState(p as Issue) },
    body: { type: 'String', resolve: (p) => (p as Issue).body },
    author: { type: 'User', resolve: () => userObject() },
    comments: {
      type: 'IssueCommentConnection',
      resolve: (p) => {
        const issue = p as Issue;
        return {
          __typename: 'IssueCommentConnection',
          nodes: issue.comments.map((c) => ({ __typename: 'IssueComment', id: globalId('comment', `c:${c.id}`), body: c.body })),
          pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
          totalCount: issue.comments.length,
        };
      },
    },
    labels: {
      type: '[Label]',
      resolve: (p) => (p as Issue).labels.map((name) => ({ __typename: 'Label', name })),
    },
    createdAt: { type: 'String', resolve: () => '2025-01-01T00:00:00Z' },
    updatedAt: { type: 'String', resolve: () => '2025-01-01T00:00:00Z' },
    url: { type: 'String', resolve: () => null },
    repository: {
      type: 'Repository',
      resolve: (p) => {
        const issue = p as Issue & { __repoId?: number };
        return repoOfIssue(issue) ?? null;
      },
    },
  },
  Label: {
    name: { type: 'String', resolve: (p) => (p as { name: string }).name },
  },
  PullRequest: {
    id: {
      type: 'ID',
      resolve: (p) => {
        const pull = p as Pull & { __repoId?: number };
        const repo = pull.__repoId !== undefined ? findRepoById(pull.__repoId) : undefined;
        return repo ? pullGlobalId(repo, pull) : globalId('pr', `?:${pull.number}`);
      },
    },
    number: { type: 'Int', resolve: (p) => (p as Pull).number },
    title: { type: 'String', resolve: (p) => (p as Pull).title },
    body: { type: 'String', resolve: (p) => (p as Pull).body },
    state: { type: 'PullRequestState', resolve: (p) => pullState(p as Pull) },
    merged: { type: 'Boolean', resolve: (p) => (p as Pull).merged },
    headRefName: { type: 'String', resolve: (p) => (p as Pull).headRef },
    baseRefName: { type: 'String', resolve: (p) => (p as Pull).baseRef },
    mergeable: {
      type: 'MergeableState',
      resolve: (p) => {
        const pull = p as Pull & { __repoId?: number };
        const repo = pull.__repoId !== undefined ? findRepoById(pull.__repoId) : undefined;
        if (!repo) return 'UNKNOWN';
        return repo.pullMergeable(pull) ? 'MERGEABLE' : 'CONFLICTING';
      },
    },
    files: { type: 'PullRequestChangedFileConnection', resolve: (p, args) => filesConnection(p as Pull, args) },
    headRef: { type: 'Ref', resolve: (p) => ({ __typename: 'Ref', name: (p as Pull).headRef }) },
    baseRef: { type: 'Ref', resolve: (p) => ({ __typename: 'Ref', name: (p as Pull).baseRef }) },
    mergedAt: { type: 'String', resolve: (p) => (p as Pull).merged_at },
    mergeCommit: { type: 'Commit', resolve: () => null },
    author: { type: 'User', resolve: () => userObject() },
    createdAt: { type: 'String', resolve: () => '2025-01-01T00:00:00Z' },
    updatedAt: { type: 'String', resolve: () => '2025-01-01T00:00:00Z' },
    url: { type: 'String', resolve: () => null },
    repository: {
      type: 'Repository',
      resolve: (p) => {
        const pull = p as Pull & { __repoId?: number };
        return pull.__repoId !== undefined ? (findRepoById(pull.__repoId) ?? null) : null;
      },
    },
  },
  IssueConnection: {
    nodes: { type: '[Issue]', resolve: (p) => (p as { nodes: unknown[] }).nodes },
    pageInfo: { type: 'PageInfo', resolve: (p) => (p as { pageInfo: unknown }).pageInfo },
    totalCount: { type: 'Int', resolve: (p) => (p as { totalCount: number }).totalCount },
  },
  PullRequestConnection: {
    nodes: { type: '[PullRequest]', resolve: (p) => (p as { nodes: unknown[] }).nodes },
    pageInfo: { type: 'PageInfo', resolve: (p) => (p as { pageInfo: unknown }).pageInfo },
    totalCount: { type: 'Int', resolve: (p) => (p as { totalCount: number }).totalCount },
  },
  PullRequestChangedFileConnection: {
    nodes: { type: '[PullRequestChangedFile]', resolve: (p) => (p as { nodes: unknown[] }).nodes },
    pageInfo: { type: 'PageInfo', resolve: (p) => (p as { pageInfo: unknown }).pageInfo },
    totalCount: { type: 'Int', resolve: (p) => (p as { totalCount: number }).totalCount },
  },
  PullRequestChangedFile: {
    path: { type: 'String', resolve: (p) => (p as { path: string }).path },
    additions: { type: 'Int', resolve: (p) => (p as { additions: number }).additions },
    deletions: { type: 'Int', resolve: (p) => (p as { deletions: number }).deletions },
    changes: { type: 'Int', resolve: (p) => (p as { changes: number }).changes },
    status: { type: 'String', resolve: (p) => (p as { status: string }).status },
  },
  IssueCommentConnection: {
    nodes: { type: '[IssueComment]', resolve: (p) => (p as { nodes: unknown[] }).nodes },
    pageInfo: { type: 'PageInfo', resolve: (p) => (p as { pageInfo: unknown }).pageInfo },
    totalCount: { type: 'Int', resolve: (p) => (p as { totalCount: number }).totalCount },
  },
  IssueComment: {
    id: { type: 'ID', resolve: (p) => (p as { id: string }).id },
    body: { type: 'String', resolve: (p) => (p as { body: string }).body },
  },
  PageInfo: {
    hasNextPage: { type: 'Boolean', resolve: (p) => (p as { hasNextPage: boolean }).hasNextPage },
    hasPreviousPage: { type: 'Boolean', resolve: (p) => (p as { hasPreviousPage: boolean }).hasPreviousPage },
    startCursor: { type: 'String', resolve: (p) => (p as { startCursor: string | null }).startCursor ?? null },
    endCursor: { type: 'String', resolve: (p) => (p as { endCursor: string | null }).endCursor ?? null },
  },
  __Type: {
    name: { type: 'String', resolve: (p) => (p as { name: string }).name },
    kind: { type: 'String', resolve: (p) => (p as { kind: string }).kind },
    description: { type: 'String', resolve: () => null },
    fields: {
      type: '[__Field]',
      resolve: (p) => (p as { fields: unknown[] | null }).fields ?? null,
    },
    enumValues: {
      type: '[__EnumValue]',
      resolve: (p) => (p as { enumValues: unknown[] | null }).enumValues ?? null,
    },
  },
  __Field: {
    name: { type: 'String', resolve: (p) => (p as { name: string }).name },
    description: { type: 'String', resolve: () => null },
    args: { type: '[__InputValue]', resolve: () => [] },
  },
  __EnumValue: {
    name: { type: 'String', resolve: (p) => (p as { name: string }).name },
    description: { type: 'String', resolve: () => null },
  },
  CreateIssuePayload: {
    issue: { type: 'Issue', resolve: (p) => (p as { issue: unknown }).issue },
  },
  CloseIssuePayload: {
    issue: { type: 'Issue', resolve: (p) => (p as { issue: unknown }).issue },
  },
  PullRequestCreatePayload: {
    pullRequest: { type: 'PullRequest', resolve: (p) => (p as { pullRequest: unknown }).pullRequest },
  },
  MergePullRequestPayload: {
    pullRequest: { type: 'PullRequest', resolve: (p) => (p as { pullRequest: unknown }).pullRequest },
  },
  AddCommentPayload: {
    commentEdge: { type: 'CommentEdge', resolve: (p) => (p as { commentEdge: unknown }).commentEdge },
  },
  CommentEdge: {
    node: { type: 'IssueComment', resolve: (p) => (p as { node: unknown }).node },
  },
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function execSelection(
  typeName: string,
  parent: unknown,
  sels: SelectionNode[],
  vars: Vars,
  ctx: Ctx,
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.kind === 'fragment') {
      if (sel.typeCond && sel.typeCond !== typeName) continue;
      Object.assign(out, execSelection(typeName, parent, sel.sel, vars, ctx, path));
      continue;
    }
    const respKey = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      out[respKey] = typeName;
      continue;
    }
    const def = SCHEMA[typeName]?.[sel.name];
    if (!def) {
      ctx.errors.push({
        message: `Cannot query field "${sel.name}" on type "${typeName}".`,
        path: [...path, respKey],
        locations: [{ line: sel.line, column: sel.col }],
      });
      out[respKey] = null;
      continue;
    }
    const args = resolveArgs(sel.args, vars);
    let value: unknown;
    try {
      value = def.resolve(parent, args, ctx);
    } catch (err) {
      ctx.errors.push({
        message: err instanceof Error ? err.message : String(err),
        path: [...path, respKey],
      });
      out[respKey] = null;
      continue;
    }
    if (value === null || value === undefined) {
      out[respKey] = null;
      continue;
    }
    if (!sel.sel) {
      out[respKey] = value;
      continue;
    }
    const retType = def.type;
    if (retType.startsWith('[')) {
      const itemType = retType.slice(1, -1);
      const arr = value as unknown[];
      out[respKey] = arr.map((item, i) => {
        if (item === null || item === undefined) return null;
        const eff = (item as { __typename?: string }).__typename ?? itemType;
        return execSelection(eff, item, sel.sel!, vars, ctx, [...path, respKey, i]);
      });
    } else {
      const eff = (value as { __typename?: string }).__typename ?? retType;
      out[respKey] = execSelection(eff, value, sel.sel, vars, ctx, [...path, respKey]);
    }
  }
  return out;
}

function executeOperationBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { data: null, errors: [{ message: 'GraphQL request body must be an object with a query string' }] };
  }
  const { query, variables, operationName } = body as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof query !== 'string' || !query.trim()) {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  const vars: Vars = (variables && typeof variables === 'object' && !Array.isArray(variables))
    ? (variables as Vars)
    : {};
  let ops: Operation[];
  try {
    ops = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (ops.length === 0) {
    return { data: null, errors: [{ message: 'Must provide an operation.' }] };
  }
  let op: Operation | undefined;
  if (typeof operationName === 'string' && operationName) {
    op = ops.find((o) => o.name === operationName);
    if (!op) return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
  } else {
    op = ops[0]!;
  }
  const ctx: Ctx = { errors: [] };
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = execSelection(rootType, {}, op.sel, vars, ctx, []);
  return { data, errors: ctx.errors };
}

/** Returns true when the request was handled. */
export async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!authed(req)) {
    sendJson(res, 401, { message: 'authentication required' });
    return true;
  }
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
  } catch {
    sendJson(res, 400, { message: 'malformed JSON body' });
    return true;
  }
  if (body === undefined) {
    sendJson(res, 400, { message: 'request body is required' });
    return true;
  }
  const results = Array.isArray(body)
    ? body.map((op) => executeOperationBody(op))
    : executeOperationBody(body);
  sendJson(res, 200, results);
  return true;
}
