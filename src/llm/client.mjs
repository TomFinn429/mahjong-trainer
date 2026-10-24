/* ============================================================
   OpenAI 兼容 Chat Completions 客户端（原生 fetch，零依赖）
   - 直连：POST {baseURL}/chat/completions
   - 代理：POST /api/llm/chat，目标地址放在 x-llm-base 头里，由 server.js 转发
   - 流式：解析 SSE（data: {...} / data: [DONE]），兼容 DeepSeek 的 reasoning_content
   ============================================================ */

/* 增量解析 SSE：喂入文本块，回调每个 data 负载；返回剩余的不完整片段 */
export function createSSEParser(onData) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      let m;
      while ((m = /\r?\n\r?\n/.exec(buf))) {
        const raw = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const data = raw.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
        if (data) onData(data);
      }
    },
    flush() {
      if (buf.trim()) { const rest = buf; buf = ''; this.push(rest + '\n\n'); }
    }
  };
}

function endpoint(cfg, path) {
  if (cfg.viaProxy) return { url: `/api/llm/${path === 'chat/completions' ? 'chat' : 'models'}`, proxy: true };
  const base = String(cfg.baseURL || '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) throw new Error('Base URL 必须以 https:// 开头');
  return { url: `${base}/${path}`, proxy: false };
}

function headers(cfg, ep) {
  const h = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`;
  if (ep.proxy) {
    h['x-llm-base'] = cfg.baseURL;
    if (cfg.sessionId) h['x-llm-session'] = cfg.sessionId;
  }
  return h;
}

async function httpError(res) {
  let msg = '';
  try {
    const text = await res.text();
    try { const j = JSON.parse(text); msg = (j.error && (j.error.message || j.error.code)) || j.message || text; } catch { msg = text; }
  } catch { /* 忽略 */ }
  const hint = res.status === 401 ? '（API key 无效或未填）' : res.status === 404 ? '（地址或模型名不对）' : res.status === 429 ? '（限流或额度不足）' : '';
  const err = new Error(`HTTP ${res.status}${hint}：${String(msg).slice(0, 300)}`);
  err.status = res.status;
  return err;
}

/* 思考强度（会思考的模型）：'low' → reasoning_effort: "low"（DeepSeek 官方最低档）；
   'off' → thinking: {type: "disabled"}（DeepSeek 官方关闭思考的写法）；其他值不发送，用服务商默认。
   不认识这些参数的服务商会返回 400：去掉参数重试一次，并在本页记住这个模型不支持 */
const noReasoningParam = new Set();
function reasoningParams(cfg, level) {
  if (noReasoningParam.has(`${cfg.baseURL}|${cfg.model}`)) return null;
  if (level === 'low') return { reasoning_effort: 'low' };
  if (level === 'off') return { thinking: { type: 'disabled' } };
  return null;
}

/* 流式对话。onDelta(text) 收到正文增量，onReasoning(text) 收到思考过程增量（若服务商提供）。
   返回值的 reasoningDropped 为 true 表示服务商不接受思考强度参数，已按默认重试 */
export async function chatStream(cfg, messages, opts = {}) {
  const extra = reasoningParams(cfg, opts.reasoning);
  if (!extra) return chatStreamOnce(cfg, messages, opts, null);
  try {
    return await chatStreamOnce(cfg, messages, opts, extra);
  } catch (e) {
    if (e.status !== 400) throw e;
    noReasoningParam.add(`${cfg.baseURL}|${cfg.model}`);
    return { ...(await chatStreamOnce(cfg, messages, opts, null)), reasoningDropped: true };
  }
}

async function chatStreamOnce(cfg, messages, { onDelta, onReasoning, signal, temperature = 0.4, maxTokens } = {}, extra) {
  const ep = endpoint(cfg, 'chat/completions');
  const body = { model: cfg.model, messages, stream: true, temperature, ...(extra || {}) };
  if (maxTokens) body.max_tokens = maxTokens;
  let res;
  try {
    res = await fetch(ep.url, { method: 'POST', headers: headers(cfg, ep), body: JSON.stringify(body), signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error(ep.proxy ? `连不上本地代理：${e.message}（请用 node server.js 启动页面）`
      : `请求失败：${e.message}（可能是网络或跨域限制，可尝试勾选「经本地代理」）`);
  }
  if (!res.ok) throw await httpError(res);

  let text = '', reasoning = '', usage = null, finish = null;
  const type = res.headers.get('content-type') || '';
  if (!type.includes('text/event-stream')) {
    // 有的服务忽略 stream:true，直接返回整段 JSON
    const j = await res.json();
    const msg = j.choices && j.choices[0] && j.choices[0].message;
    text = (msg && msg.content) || '';
    if (text && onDelta) onDelta(text);
    return { text, reasoning, usage: j.usage || null, finish: j.choices && j.choices[0] && j.choices[0].finish_reason };
  }
  const parser = createSSEParser(data => {
    if (data === '[DONE]') return;
    let j;
    try { j = JSON.parse(data); } catch { return; }
    if (j.error) throw new Error(j.error.message || '服务端返回错误');
    if (j.usage) usage = j.usage;
    const ch = j.choices && j.choices[0];
    if (!ch) return;
    if (ch.finish_reason) finish = ch.finish_reason;
    const d = ch.delta || {};
    if (d.reasoning_content || d.reasoning) { const r = d.reasoning_content || d.reasoning; reasoning += r; if (onReasoning) onReasoning(r); }
    if (d.content) { text += d.content; if (onDelta) onDelta(d.content); }
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.push(dec.decode(value, { stream: true }));
  }
  parser.push(dec.decode());
  parser.flush();
  return { text, reasoning, usage, finish };
}

export async function listModels(cfg, { signal } = {}) {
  const ep = endpoint(cfg, 'models');
  const res = await fetch(ep.url, { headers: headers(cfg, ep), signal });
  if (!res.ok) throw await httpError(res);
  const j = await res.json();
  return (j.data || j.models || []).map(m => (typeof m === 'string' ? m : m.id)).filter(Boolean).sort();
}
