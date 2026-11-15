// CompactRank Aggregator — one-file free-model router for make.fun free-model-aggregator-02.
//
// What it does, in short: read the trial brief, rank every free model in it by the
// published rating, and answer each client request with the best-ranked model that
// can actually serve it. Both client wires are served (OpenAI Chat Completions and
// Anthropic Messages, JSON and SSE), every upstream call goes to the gateway's Chat
// Completions route, and the `model` field on every answer and chunk is the id that
// was really dialled. Refusals (429 / 5xx / network) fail over to the next ranked
// model; a per-model strike counter cools repeat offenders down for a few requests
// and resets the moment that model succeeds again. No clocks, no dice: routing is a
// pure function of the brief, the request and the gateway answers seen so far, so a
// replay walks the exact same path.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
const asNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const asTri = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const clampCode = (s: string): string => s.slice(0, 64);

// ---------------------------------------------------------------- brief parsing
// The brief is prose with two JSON documents buried in it. We fish them out by
// brace-matching every "{" and keeping the parses that carry our schema prefix.

interface Mdl { id: string; name: string; rating: number; ctx: number | null; tools: boolean | null; vision: boolean | null; json: boolean | null }
interface Need { tools: boolean; vision: boolean; json: boolean }

function braceEnd(txt: string, open: number): number {
  let depth = 0, quoted = false;
  for (let i = open; i < txt.length; i++) {
    const c = txt[i];
    if (quoted) { if (c === '\\') i++; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

function briefDocs(txt: string): Rec[] {
  const found: Rec[] = [];
  for (let at = txt.indexOf('{'); at !== -1; at = txt.indexOf('{', at + 1)) {
    const end = braceEnd(txt, at);
    if (end < 0) continue;
    try {
      const v: unknown = JSON.parse(txt.slice(at, end + 1));
      if (isRec(v) && asStr(v.schema).includes('free-model-aggregator-02/')) found.push(v);
    } catch { /* prose, not JSON — keep scanning */ }
  }
  return found;
}

function loadPool(path: string): Mdl[] {
  if (!path) return [];
  let docs: Rec[];
  try { docs = briefDocs(readFileSync(path, 'utf8')); } catch { return []; }
  let rows: unknown[] = [];
  for (const d of docs) {
    if (Array.isArray(d.models)) { rows = d.models; break; }
    if (Array.isArray(d.ratings)) { rows = d.ratings; break; }
  }
  const pool: Mdl[] = [];
  for (const raw of rows) {
    if (!isRec(raw) || raw.free === false) continue;
    let id = asStr(raw.id) || asStr(raw.model);
    if (!id) continue;
    const prov = asStr(raw.provider) || 'openrouter';
    if (prov === 'openrouter' && !id.startsWith('openrouter/')) id = `openrouter/${id}`;
    pool.push({
      id, name: asStr(raw.display_name) || id,
      rating: asNum(raw.rating_milli) ?? 0, ctx: asNum(raw.context_length),
      tools: asTri(raw.tools), vision: asTri(raw.vision), json: asTri(raw.json),
    });
  }
  return pool;
}

// ------------------------------------------------------------------ the catalog
// Built once from the brief; --list prints it and /register posts it, same bytes.

const POOL: Mdl[] = loadPool(process.env.MAKEFUN_PROMPT_FILE ?? '');
const CATALOG: Rec = POOL.length === 0 ? { providers: [] } : {
  providers: [{
    id: 'openrouter', base_url: 'https://openrouter.ai/api/v1',
    key_env: 'OPENROUTER_API_KEY', wire: 'openai',
    models: POOL.map((m) => ({ id: m.id, free: true, context_length: m.ctx })),
  }],
};
const CATALOG_JSON = JSON.stringify(CATALOG);

// ------------------------------------------------------------------ trial wiring
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const GW_BASE = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
const GW_KEY = process.env.OPENAI_API_KEY ?? '';
const gwUrl = (): string => (GW_BASE.endsWith('/v1') ? `${GW_BASE}/chat/completions` : `${GW_BASE}/v1/chat/completions`);
const note = (s: string): void => { process.stderr.write(`compactrank: ${s}\n`); };

// ------------------------------------------------------- strikes and cooldowns
// strikes: consecutive failures per model, wiped by that model's next success.
// chillUntil: request tick at which a cooled model may be dialled again. Time is
// counted in requests served, never in seconds, so replays stay deterministic.

const strikes = new Map<string, number>();
const chillUntil = new Map<string, number>();
let tick = 0; // completion requests started so far

const CHILL_AFTER = 2;   // consecutive failures that trigger a cooldown
// The sit-out grows with the streak: a model that keeps refusing after coming
// back earns a longer bench each time (3, 6, 9, ... capped at 12 requests).
const chillSpan = (n: number): number => Math.min(3 + (n - CHILL_AFTER) * 3, 12);

function markFail(id: string): void {
  const n = (strikes.get(id) ?? 0) + 1;
  strikes.set(id, n);
  if (n >= CHILL_AFTER) chillUntil.set(id, tick + chillSpan(n));
}
function markWin(id: string): void { strikes.delete(id); chillUntil.delete(id); }
const isChilled = (id: string): boolean => (chillUntil.get(id) ?? 0) > tick;

// -------------------------------------------------------------------- routing
// Rating-greedy: highest rating_milli first, id as the deterministic tie-break.
// A model only ranks when every capability the request needs is a hard `true`
// in the brief; an unknown capability never qualifies.

function fits(m: Mdl, need: Need): boolean {
  if (need.tools && m.tools !== true) return false;
  if (need.vision && m.vision !== true) return false;
  if (need.json && m.json !== true) return false;
  return true;
}

// Effective rank: raw rating minus a strike toll, so among near-equals a clean
// model beats one that just refused, while a far stronger model still leads.
const effRank = (m: Mdl): number => m.rating - 75 * (strikes.get(m.id) ?? 0);

function rankFor(need: Need, wanted: string): Mdl[] {
  const able = POOL.filter((m) => fits(m, need));
  const warm = able.filter((m) => !isChilled(m.id));
  // Warm models go by effective rank. If every able model is chilled, the one
  // whose bench ends soonest leads instead of the raw favourite: it is the
  // likeliest to answer, and hammering the longest-benched wastes the prompt.
  const ranked = warm.length > 0
    ? [...warm].sort((a, b) => effRank(b) - effRank(a) || b.rating - a.rating || (a.id < b.id ? -1 : 1))
    : [...able].sort((a, b) => (chillUntil.get(a.id) ?? 0) - (chillUntil.get(b.id) ?? 0) || b.rating - a.rating || (a.id < b.id ? -1 : 1));
  // A client that names a concrete free model gets it first; "auto" gets pure rank.
  if (wanted && wanted !== 'auto') {
    const at = ranked.findIndex((m) => m.id === wanted);
    if (at > 0) { const [head] = ranked.splice(at, 1); ranked.unshift(head); }
  }
  return ranked;
}

// What a request body demands, read off the body itself (either wire's spelling).
function needOf(wire: 'openai' | 'anthropic', body: Rec): Need {
  const need: Need = { tools: Array.isArray(body.tools) && body.tools.length > 0, vision: false, json: false };
  if (wire === 'openai' && isRec(body.response_format)) {
    need.json = body.response_format.type === 'json_object' || body.response_format.type === 'json_schema';
  }
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (const msg of msgs) {
    if (!isRec(msg) || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (!isRec(part)) continue;
      if (part.type === 'image' || part.type === 'image_url') need.vision = true;
    }
  }
  return need;
}

// ------------------------------------------------------------- wire translation
// Anthropic in -> OpenAI body out; OpenAI answer in -> Anthropic body out. The
// gateway only speaks Chat Completions, so the Anthropic wire is a translation
// both ways; the OpenAI wire passes through with only the model swapped.

function flatText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => isRec(b) && b.type === 'text' && typeof b.text === 'string').map((b) => (b as Rec).text as string).join('\n');
}

function anthroToOpen(body: Rec, model: string): Rec {
  const msgs: Rec[] = [];
  const sys = flatText(body.system);
  if (sys) msgs.push({ role: 'system', content: sys });
  for (const raw of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRec(raw)) continue;
    const role = raw.role === 'assistant' ? 'assistant' : 'user';
    if (typeof raw.content === 'string') { msgs.push({ role, content: raw.content }); continue; }
    if (!Array.isArray(raw.content)) continue;
    if (role === 'assistant') {
      const calls: Rec[] = [];
      for (const blk of raw.content) {
        if (!isRec(blk) || blk.type !== 'tool_use') continue;
        calls.push({ id: asStr(blk.id), type: 'function', function: { name: asStr(blk.name), arguments: JSON.stringify(isRec(blk.input) ? blk.input : {}) } });
      }
      const txt = flatText(raw.content);
      msgs.push({ role, content: txt === '' ? null : txt, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    const parts: Rec[] = [];
    for (const blk of raw.content) {
      if (!isRec(blk)) continue;
      if (blk.type === 'tool_result') {
        const inner = blk.content;
        msgs.push({ role: 'tool', tool_call_id: asStr(blk.tool_use_id), content: typeof inner === 'string' ? inner : (flatText(inner) || JSON.stringify(inner ?? '')) });
      } else if (blk.type === 'text' && typeof blk.text === 'string') {
        parts.push({ type: 'text', text: blk.text });
      } else if (blk.type === 'image' && isRec(blk.source)) {
        const src = blk.source;
        if (src.type === 'base64' && typeof src.data === 'string') parts.push({ type: 'image_url', image_url: { url: `data:${asStr(src.media_type) || 'image/png'};base64,${src.data}` } });
        else if (src.type === 'url' && typeof src.url === 'string') parts.push({ type: 'image_url', image_url: { url: src.url } });
      }
    }
    if (parts.length) msgs.push({ role: 'user', content: parts });
  }
  const out: Rec = { model, messages: msgs };
  out.max_tokens = Math.min(asNum(body.max_tokens) ?? 1024, 8192);
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools)) {
    const tools = body.tools.filter((t) => isRec(t) && typeof t.name === 'string').map((t) => {
      const tool = t as Rec;
      return { type: 'function', function: { name: tool.name as string, description: asStr(tool.description), parameters: isRec(tool.input_schema) ? tool.input_schema : { type: 'object', properties: {} } } };
    });
    if (tools.length) out.tools = tools;
  }
  if (isRec(body.tool_choice)) {
    const tc = body.tool_choice;
    if (tc.type === 'auto') out.tool_choice = 'auto';
    else if (tc.type === 'any') out.tool_choice = 'required';
    else if (tc.type === 'tool' && typeof tc.name === 'string') out.tool_choice = { type: 'function', function: { name: tc.name } };
  }
  if (body.stream === true) { out.stream = true; out.stream_options = { include_usage: true }; }
  return out;
}

function openBody(body: Rec): Rec {
  const out: Rec = { ...body };
  if (asNum(out.max_tokens) === null && asNum(out.max_completion_tokens) === null) out.max_tokens = 1024;
  if ((asNum(out.max_tokens) ?? 0) > 8192) out.max_tokens = 8192;
  if (out.stream === true) out.stream_options = { ...(isRec(out.stream_options) ? out.stream_options : {}), include_usage: true };
  return out;
}

const STOP_MAP: Record<string, string> = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'refusal' };
const stopAnthro = (finish: unknown): string => STOP_MAP[asStr(finish)] ?? 'end_turn';

// Token estimate used only when an upstream answer carries no usage at all, so
// the wire still reports whole counts; a function of the texts alone.
const estTok = (s: string): number => Math.max(1, Math.ceil(s.length / 4));

function normUsage(usage: unknown, inText: string, outText: string): { prompt_tokens: number; completion_tokens: number } {
  const u = isRec(usage) ? usage : {};
  const pin = asNum(u.prompt_tokens), pout = asNum(u.completion_tokens);
  return {
    prompt_tokens: pin !== null && pin >= 0 ? pin : estTok(inText),
    completion_tokens: pout !== null && pout >= 1 ? pout : estTok(outText),
  };
}

function openToAnthro(ans: Rec, model: string, reqText: string): Rec {
  const choice = Array.isArray(ans.choices) && isRec(ans.choices[0]) ? ans.choices[0] : {};
  const msg = isRec(choice.message) ? choice.message : {};
  const blocks: Rec[] = [];
  const txt = typeof msg.content === 'string' ? msg.content : flatText(msg.content);
  if (txt) blocks.push({ type: 'text', text: txt });
  for (const call of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
    if (!isRec(call) || !isRec(call.function)) continue;
    let input: unknown = {};
    if (typeof call.function.arguments === 'string' && call.function.arguments.trim()) {
      try { const p: unknown = JSON.parse(call.function.arguments); if (isRec(p)) input = p; } catch { /* keep {} */ }
    } else if (isRec(call.function.arguments)) input = call.function.arguments;
    blocks.push({ type: 'tool_use', id: asStr(call.id) || 'toolu_0', name: asStr(call.function.name), input });
  }
  if (!blocks.length) blocks.push({ type: 'text', text: '' });
  const usage = normUsage(ans.usage, reqText, txt);
  return {
    id: `msg_${asStr(ans.id) || 'cr'}`, type: 'message', role: 'assistant', model, content: blocks,
    stop_reason: stopAnthro(choice.finish_reason), stop_sequence: null,
    usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens },
  };
}

const sse = (event: string | null, data: unknown): string => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;

// One upstream SSE body, frame by frame; a frame is the text up to a blank line.
async function* framesOf(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let cut = buf.indexOf('\n\n');
      while (cut !== -1) { yield buf.slice(0, cut); buf = buf.slice(cut + 2); cut = buf.indexOf('\n\n'); }
    }
    buf += dec.decode();
    if (buf.trim()) yield buf;
  } finally { reader.releaseLock(); }
}

function frameData(frame: string): string | null {
  for (const line of frame.split('\n')) {
    const t = line.trim();
    if (t.startsWith('data:')) return t.slice(5).trim();
  }
  return null;
}

// OpenAI stream relay: same frames back, every JSON payload re-stamped with the
// dialled id, and a [DONE] appended when the upstream forgot to close.
async function relayOpenStream(body: ReadableStream<Uint8Array>, model: string, res: ServerResponse): Promise<void> {
  let sawDone = false;
  for await (const frame of framesOf(body)) {
    const payload = frameData(frame);
    if (payload === '[DONE]') { sawDone = true; res.write('data: [DONE]\n\n'); continue; }
    if (payload) {
      try {
        const chunk: unknown = JSON.parse(payload);
        if (isRec(chunk)) { res.write(`data: ${JSON.stringify({ ...chunk, model })}\n\n`); continue; }
      } catch { /* not JSON: pass the frame through untouched */ }
    }
    res.write(`${frame}\n\n`);
  }
  if (!sawDone) res.write('data: [DONE]\n\n');
}

// OpenAI stream -> Anthropic events. Blocks open on first content, close before
// message_delta; the stop reason waits for the usage chunk, which OpenAI sends
// last, so message_delta can carry the real output count.
async function relayAnthroStream(body: ReadableStream<Uint8Array>, model: string, res: ServerResponse): Promise<void> {
  let started = false, finished = false, nextIdx = 0, textIdx = -1, pendingStop: string | null = null;
  let inTok = 0, outTok = 0, heardText = '';
  const toolIdx = new Map<number, number>();
  const open = (ev: string): void => { res.write(ev); };
  const begin = (): void => {
    if (started) return; started = true;
    open(sse('message_start', { type: 'message_start', message: { id: 'msg_crstream', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inTok, output_tokens: 0 } } }));
  };
  const closeBlocks = (): void => {
    if (textIdx !== -1) { open(sse('content_block_stop', { type: 'content_block_stop', index: textIdx })); textIdx = -1; }
    for (const idx of [...toolIdx.values()].sort((a, b) => a - b)) open(sse('content_block_stop', { type: 'content_block_stop', index: idx }));
    toolIdx.clear();
  };
  const finish = (): void => {
    if (finished) return; finished = true; begin(); closeBlocks();
    const out = outTok >= 1 ? outTok : estTok(heardText);
    open(sse('message_delta', { type: 'message_delta', delta: { stop_reason: pendingStop ?? 'end_turn', stop_sequence: null }, usage: { output_tokens: out } }));
    open(sse('message_stop', { type: 'message_stop' }));
  };
  for await (const frame of framesOf(body)) {
    const payload = frameData(frame);
    if (payload === null || payload === '') continue;
    if (payload === '[DONE]') { finish(); continue; }
    let chunk: unknown;
    try { chunk = JSON.parse(payload); } catch { continue; }
    if (!isRec(chunk)) continue;
    if (isRec(chunk.usage)) { inTok = asNum(chunk.usage.prompt_tokens) ?? inTok; outTok = asNum(chunk.usage.completion_tokens) ?? outTok; }
    const choice = Array.isArray(chunk.choices) && isRec(chunk.choices[0]) ? chunk.choices[0] : null;
    if (!choice) continue;
    const delta = isRec(choice.delta) ? choice.delta : {};
    begin();
    if (typeof delta.content === 'string' && delta.content !== '') {
      heardText += delta.content;
      if (textIdx === -1) { textIdx = nextIdx++; open(sse('content_block_start', { type: 'content_block_start', index: textIdx, content_block: { type: 'text', text: '' } })); }
      open(sse('content_block_delta', { type: 'content_block_delta', index: textIdx, delta: { type: 'text_delta', text: delta.content } }));
    }
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      if (!isRec(call)) continue;
      const upIdx = asNum(call.index) ?? toolIdx.size;
      let idx = toolIdx.get(upIdx);
      if (idx === undefined) {
        if (textIdx !== -1) { open(sse('content_block_stop', { type: 'content_block_stop', index: textIdx })); textIdx = -1; }
        idx = nextIdx++; toolIdx.set(upIdx, idx);
        const fn = isRec(call.function) ? call.function : {};
        open(sse('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: asStr(call.id) || `toolu_${idx}`, name: asStr(fn.name), input: {} } }));
      }
      const fn = isRec(call.function) ? call.function : {};
      if (typeof fn.arguments === 'string' && fn.arguments !== '') {
        open(sse('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: fn.arguments } }));
      }
    }
    if (typeof choice.finish_reason === 'string') pendingStop = stopAnthro(choice.finish_reason);
  }
  finish();
}

// ----------------------------------------------------------------- HTTP plumbing
const MAX_BODY = 8 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<Rec | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const piece of req) {
    const buf = Buffer.isBuffer(piece) ? piece : Buffer.from(String(piece));
    size += buf.length;
    if (size > MAX_BODY) return null;
    chunks.push(buf);
  }
  if (!chunks.length) return null;
  try { const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); return isRec(v) ? v : null; } catch { return null; }
}

interface Fail { status: number; code: string; model: string | null }
const trailHead = (trail: Fail[]): Rec => (trail.length ? { 'x-makefun-upstream-failures': JSON.stringify(trail.slice(0, 8)) } : {});

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Rec = {}): void {
  const txt = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(txt), ...extra });
  res.end(txt);
}
const errOpen = (message: string, type: string): Rec => ({ error: { message, type, code: null } });
const errAnthro = (type: string, message: string): Rec => ({ type: 'error', error: { type, message } });
function sendErr(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string, trail: Fail[] = []): void {
  sendJson(res, status, wire === 'anthropic' ? errAnthro(type, message) : errOpen(message, type), trailHead(trail));
}

function modelsReply(req: IncomingMessage, res: ServerResponse): void {
  if (typeof req.headers['x-api-key'] === 'string') {
    sendJson(res, 200, { data: POOL.map((m) => ({ type: 'model', id: m.id, display_name: m.name, created_at: '2026-01-01T00:00:00Z' })), has_more: false });
  } else {
    sendJson(res, 200, { object: 'list', data: POOL.map((m) => ({ id: m.id, object: 'model', created: 1767225600, owned_by: 'openrouter' })) });
  }
}

// -------------------------------------------------------------------- the dial
async function dial(id: string, payload: Rec): Promise<Response> {
  return fetch(gwUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${GW_KEY}`, ...(payload.stream === true ? { accept: 'text/event-stream' } : {}) },
    body: JSON.stringify({ ...payload, model: id }),
    signal: AbortSignal.timeout(18000),
  });
}

function codeOf(text: string): string {
  try {
    const v: unknown = JSON.parse(text);
    if (isRec(v) && isRec(v.error)) return clampCode(asStr(v.error.code) || asStr(v.error.type));
  } catch { /* body was not JSON */ }
  return '';
}

// Serve one completion request: rank, dial, fail over on 429 / 5xx / network
// trouble, translate the winning answer back onto the client's wire.
async function serve(wire: 'openai' | 'anthropic', client: Rec, res: ServerResponse): Promise<void> {
  tick++;
  const need = needOf(wire, client);
  const order = rankFor(need, asStr(client.model));
  if (!order.length) { sendErr(res, wire, 503, wire === 'anthropic' ? 'overloaded_error' : 'no_free_model', 'no free model in the brief can serve this request'); return; }
  const base = wire === 'openai' ? openBody(client) : anthroToOpen(client, '');
  const reqText = JSON.stringify(client.messages ?? '');
  const wantStream = client.stream === true;
  const trail: Fail[] = [];
  const tried = new Set<string>();
  let lastMsg = 'every ranked model refused';

  for (const cand of order) {
    if (tried.has(cand.id)) continue;
    tried.add(cand.id);
    let up: Response;
    try { up = await dial(cand.id, base); }
    catch (err) {
      markFail(cand.id);
      trail.push({ status: 502, code: clampCode((err as Error).name || 'network_error'), model: cand.id });
      lastMsg = (err as Error).message;
      continue;
    }
    if (up.status === 429 || up.status >= 500) {
      const text = await up.text().catch(() => '');
      markFail(cand.id);
      trail.push({ status: up.status, code: codeOf(text), model: cand.id });
      lastMsg = `gateway answered HTTP ${up.status}`;
      continue;
    }
    if (!up.ok || !up.body) {
      const text = await up.text().catch(() => '');
      markFail(cand.id);
      sendErr(res, wire, 502, wire === 'anthropic' ? 'api_error' : 'upstream_error', `gateway answered HTTP ${up.status}${text ? `: ${text.slice(0, 300)}` : ''}`, trail);
      return;
    }
    // A live answer: this model's slate is wiped clean before we relay it.
    markWin(cand.id);
    if (wantStream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...trailHead(trail) });
      try {
        if (wire === 'openai') await relayOpenStream(up.body, cand.id, res);
        else await relayAnthroStream(up.body, cand.id, res);
      } finally { res.end(); }
      return;
    }
    const text = await up.text();
    let ans: unknown;
    try { ans = JSON.parse(text); } catch {
      markFail(cand.id);
      trail.push({ status: 502, code: 'bad_upstream_body', model: cand.id });
      lastMsg = 'gateway answered a non-JSON body';
      continue;
    }
    if (!isRec(ans)) { markFail(cand.id); trail.push({ status: 502, code: 'bad_upstream_body', model: cand.id }); continue; }
    if (wire === 'openai') {
      const choice = Array.isArray(ans.choices) && isRec(ans.choices[0]) ? ans.choices[0] : {};
      const msg = isRec(choice.message) ? choice.message : {};
      const outText = typeof msg.content === 'string' ? msg.content : flatText(msg.content);
      const usage = normUsage(ans.usage, reqText, outText);
      sendJson(res, 200, { ...ans, model: cand.id, usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens } }, trailHead(trail));
    } else {
      sendJson(res, 200, openToAnthro(ans, cand.id, reqText), trailHead(trail));
    }
    return;
  }
  sendErr(res, wire, 502, wire === 'anthropic' ? 'api_error' : 'upstream_error', lastMsg, trail);
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://cr');
  if (req.method === 'GET' && url.pathname === '/v1/models') { modelsReply(req, res); return; }
  if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/v1/messages')) {
    const wire = url.pathname === '/v1/messages' ? 'anthropic' : 'openai';
    const body = await readBody(req);
    if (!body) { sendErr(res, wire, 400, 'invalid_request_error', 'request body is not one JSON object'); return; }
    await serve(wire, body, res);
    return;
  }
  sendErr(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

// ------------------------------------------------------------------ trial loop
async function boot(): Promise<void> {
  if (process.argv.includes('--list')) {
    await new Promise<void>((done) => process.stdout.write(`${CATALOG_JSON}\n`, () => done()));
    process.exit(0);
  }
  if (!ENV_URL) throw new Error('MAKEFUN_ENV_URL is not set');
  if (!GW_BASE) throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void route(req, res).catch((err: unknown) => {
      note((err as Error).stack ?? String(err));
      if (!res.headersSent) sendErr(res, req.url?.startsWith('/v1/messages') ? 'anthropic' : 'openai', 500, 'internal_error', 'server failed to answer');
    });
  });
  // Ephemeral port, never 8080 (the env owns it on one layout): re-roll on clash.
  let port = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', () => resolve()); });
    const addr = server.address();
    if (addr && typeof addr === 'object' && addr.port !== 8080) { port = addr.port; break; }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (!port) throw new Error('could not claim a non-8080 port');
  note(`CompactRank Aggregator listening on 0.0.0.0:${port}, ${POOL.length} free models ranked`);
  const reg = await fetch(`${ENV_URL}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: 1, port, catalog: CATALOG }),
    signal: AbortSignal.timeout(5000),
  });
  if (!reg.ok) throw new Error(`register answered HTTP ${reg.status}: ${(await reg.text()).slice(0, 300)}`);
  const ack: unknown = await reg.json().catch(() => null);
  if (isRec(ack) && typeof ack.requests === 'number') note(`registered; trial holds ${ack.requests} prompts`);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return; busy = true;
    void (async () => {
      try {
        const r = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (r.status === 200) {
          const w: unknown = await r.json();
          if (isRec(w) && w.done === true) { clearInterval(timer); server.close(); process.exit(0); }
        }
      } catch { /* env not answering yet; next tick retries */ } finally { busy = false; }
    })();
  }, 100);
}

try { await boot(); } catch (err) { note((err as Error).stack ?? String(err)); process.exit(1); }
