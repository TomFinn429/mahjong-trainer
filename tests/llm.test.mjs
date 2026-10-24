import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createSSEParser, chatStream } from '../src/llm/client.mjs';
import { buildMessages, validateExplanation, serializeAnalysis } from '../src/llm/prompt.mjs';
import { PROXY_TARGETS } from '../src/llm/providers.mjs';
import { analyze } from '../src/ai/analyzer.mjs';
import { viewFor } from '../src/game/engine.mjs';
import { setup } from './helpers.mjs';

const require = createRequire(import.meta.url);

test('SSE 解析：跨块拼接、CRLF、注释行、[DONE]', () => {
  const got = [];
  const p = createSSEParser(d => got.push(d));
  p.push('data: {"a":1}\n\n: keep-alive\n\nda');
  p.push('ta: {"b":2}\r\n\r\ndata: [DONE]');
  p.flush();
  assert.deepEqual(got, ['{"a":1}', '{"b":2}', '[DONE]']);
});

function sseResponse(chunks) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) { for (const x of chunks) c.enqueue(enc.encode(x)); c.close(); }
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('chatStream：拼出正文与思考过程，携带 Bearer key', async () => {
  const orig = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return sseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"打"}}]}\n\ndata: {"choices":[{"delta":{"content":"5万"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n'
    ]);
  };
  try {
    const deltas = [];
    const r = await chatStream({ baseURL: 'https://api.example.com/v1/', apiKey: 'sk-x', model: 'm' }, [{ role: 'user', content: 'hi' }], { onDelta: d => deltas.push(d) });
    assert.equal(r.text, '打5万');
    assert.equal(r.reasoning, '想');
    assert.equal(r.finish, 'stop');
    assert.deepEqual(deltas, ['打', '5万']);
    assert.equal(seen.url, 'https://api.example.com/v1/chat/completions');
    assert.equal(seen.init.headers.Authorization, 'Bearer sk-x');
    assert.equal(JSON.parse(seen.init.body).stream, true);
  } finally { globalThis.fetch = orig; }
});

test('chatStream：HTTP 错误给出可读提示', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 });
  try {
    await assert.rejects(chatStream({ baseURL: 'https://a.b/v1', apiKey: 'k', model: 'm' }, []), /401.*API key.*bad key/);
  } finally { globalThis.fetch = orig; }
});

test('chatStream：思考强度参数；服务商返回 400 时去掉参数重试，并记住该模型不支持', async () => {
  const orig = globalThis.fetch;
  const bodies = [];
  let reject = false;
  globalThis.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    bodies.push(b);
    if (reject && (b.reasoning_effort || b.thinking)) return new Response(JSON.stringify({ error: { message: 'unknown field reasoning_effort' } }), { status: 400 });
    return sseResponse(['data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n']);
  };
  try {
    const ok = { baseURL: 'https://ok.example/v1', model: 'm' };
    await chatStream(ok, [], { reasoning: 'low' });
    assert.equal(bodies.at(-1).reasoning_effort, 'low');
    await chatStream(ok, [], { reasoning: 'off' });
    assert.deepEqual(bodies.at(-1).thinking, { type: 'disabled' });
    await chatStream(ok, [], { reasoning: 'default' });
    assert.ok(!('reasoning_effort' in bodies.at(-1)) && !('thinking' in bodies.at(-1)));

    reject = true;
    const no = { baseURL: 'https://no.example/v1', model: 'm' };
    const n0 = bodies.length;
    const r = await chatStream(no, [], { reasoning: 'low' });
    assert.equal(r.text, '好');
    assert.equal(r.reasoningDropped, true);
    assert.equal(bodies.length - n0, 2, '带参数被拒后不带参数重试');
    await chatStream(no, [], { reasoning: 'low' });
    assert.equal(bodies.length - n0, 3, '之后同一模型不再发送参数');
    assert.ok(!('reasoning_effort' in bodies.at(-1)));
  } finally { globalThis.fetch = orig; }
});

test('拒绝非 https 的直连地址', async () => {
  await assert.rejects(chatStream({ baseURL: 'http://a.b/v1', model: 'm' }, []), /https/);
});

function sampleAnalysis() {
  const g = setup({
    hands: ['123m 456m 78m 11s 234s 9s', '1p', '2p', '3p'], voids: [2, 0, 0, 0], wall: '5s 6s'
  });
  return { g, a: analyze(viewFor(g, 0)) };
}

test('分析 → 提示词：牌用中文、含候选编号与程序推荐', () => {
  const { g, a } = sampleAnalysis();
  assert.ok(a.candidates.length > 1);
  const data = serializeAnalysis(a, g.rules);
  assert.match(data.你的手牌, /1万 2万 3万/);
  assert.equal(data.候选打法[0].编号, 'c1');
  const msgs = buildMessages(a, g.rules, { question: '为什么不打 1条？' });
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /只能使用【局面数据】/);
  assert.match(msgs[1].content, /为什么不打 1条/);
  assert.match(msgs[1].content, /程序推荐/);
});

test('讲解校验：发现数据里没有的牌、与推荐不一致', () => {
  const { a } = sampleAnalysis();
  const rec = a.candidates[0];
  const recName = (rec.tile % 9 + 1) + ['万', '条', '筒'][Math.floor(rec.tile / 9)];
  const ok = validateExplanation(`**建议**：c1 打 ${recName}`, a);
  assert.deepEqual(ok.warnings, []);
  const bad = validateExplanation('**建议**：打 9筒，等 七筒', a);
  assert.ok(bad.unknown.includes('9筒') && bad.unknown.includes('7筒'));
  assert.equal(bad.warnings.length, 2);
});

/* ---------- 本地代理 ---------- */
test('server.js：静态文件、目录穿越、白名单、同源校验、流式转发', async () => {
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: req.headers['x-opencode-session'] ? 'S' : 'N' } }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: req.headers.authorization + '|' + JSON.parse(body).model } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const upBase = `http://127.0.0.1:${upstream.address().port}/v1`;
  process.env.LLM_PROXY_ALLOW = upBase;
  process.env.PORT = String(20000 + Math.floor(Math.random() * 20000));
  delete require.cache[require.resolve('../server.js')];
  const { server } = require('../server.js');
  const port = +process.env.PORT;
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${port}`;
  try {
    let r = await fetch(`${origin}/index.html`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    r = await fetch(`${origin}/src/core/core.mjs`);
    assert.match(r.headers.get('content-type'), /javascript/);
    r = await fetch(`${origin}/%2e%2e/%2e%2e/Windows/win.ini`);
    assert.notEqual(r.status, 200);
    r = await fetch(`${origin}/.git/config`);
    assert.equal(r.status, 404);
    r = await fetch(`${origin}/package.json`);
    assert.equal(r.status, 404);
    r = await fetch(`${origin}/work/ui-smoke.cjs`);
    assert.equal(r.status, 404);

    const post = (headers) => fetch(`${origin}/api/llm/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin, ...headers }, body: JSON.stringify({ model: 'mm', messages: [] })
    });
    r = await post({ 'x-llm-base': 'https://evil.example.com/v1' });
    assert.equal(r.status, 400);
    r = await post({ 'x-llm-base': upBase, origin: 'https://evil.example.com' });
    assert.equal(r.status, 403);
    r = await post({ 'x-llm-base': upBase, authorization: 'Bearer k1' });
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.match(text, /"content":"N"/, '非 OpenCode 目标不加会话头');
    assert.match(text, /Bearer k1\|mm/);
  } finally {
    server.close(); upstream.close();
  }
});

test('代理白名单与预置服务商一致', () => {
  const { ALLOW } = require('../server.js');
  for (const t of PROXY_TARGETS) assert.ok(ALLOW.has(t), t);
});
