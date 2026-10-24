/* ============================================================
   对局界面：牌桌渲染、人类操作、电脑节奏、局势分析面板、AI 讲解
   ============================================================ */
import { suitOf, rankOf, tileCN, FAN_LABEL } from '../core/core.mjs';
import { createGame, pending, submit, viewFor } from '../game/engine.mjs';
import { createBot, decide, runBots, LEVEL_NAME } from '../ai/bots.mjs';
import { exportRecord } from '../game/record.mjs';
import { analyze, isKeyMoment } from '../ai/analyzer.mjs';
import { PROVIDERS, providerById } from '../llm/providers.mjs';
import { chatStream, listModels } from '../llm/client.mjs';
import { buildMessages, validateExplanation, seatName } from '../llm/prompt.mjs';

const $ = s => document.querySelector(s);
const ME = 0;
const SUIT_CN = ['万', '条', '筒'];
const SUIT_CLS = ['w', 't', 'd'];
const SKEY = 'mjtable.settings.v1';
const KKEY = 'mjtable.apikey.v1';

const store = {
  get(area, k) { try { return area.getItem(k); } catch { return null; } },
  set(area, k, v) { try { area.setItem(k, v); } catch { /* 隐私模式等 */ } },
  del(area, k) { try { area.removeItem(k); } catch { /* 忽略 */ } }
};

const S = {
  g: null, bots: [], level: 3, speed: 450, exchange: true, practice: false, reveal: false,
  totals: [0, 0, 0, 0], games: 0, dealer: 0,
  selected: [], analysis: null, feedback: null, timer: null,
  llmAbort: null, explainedSeq: -1, sessionId: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()))
};

/* ---------- 设置持久化 ---------- */
function loadSettings() {
  let o = {};
  try { o = JSON.parse(store.get(localStorage, SKEY) || '{}'); } catch { o = {}; }
  S.level = o.level || 3; S.speed = o.speed || 450;
  S.exchange = o.exchange !== false; S.practice = !!o.practice;
  S.llm = { provider: 'deepseek', baseURL: '', model: '', viaProxy: false, detail: 'normal', autoKey: false, ...(o.llm || {}) };
  S.llm.apiKey = store.get(localStorage, KKEY) || store.get(sessionStorage, KKEY) || '';
  S.llm.remember = !!store.get(localStorage, KKEY);
}
function saveSettings() {
  const { apiKey, remember, ...llm } = S.llm;
  store.set(localStorage, SKEY, JSON.stringify({ level: S.level, speed: S.speed, exchange: S.exchange, practice: S.practice, llm }));
  if (remember) { store.set(localStorage, KKEY, apiKey); store.del(sessionStorage, KKEY); }
  else { store.set(sessionStorage, KKEY, apiKey); store.del(localStorage, KKEY); }
}

/* ---------- 牌 ---------- */
function tileEl(k, opts = {}) {
  const d = document.createElement('div');
  if (k === null || k === undefined) { d.className = 'tile back' + (opts.sm ? ' sm' : ''); return d; }
  d.className = `tile ${SUIT_CLS[suitOf(k)]}` + (opts.sm ? ' sm' : '') + (opts.cls ? ' ' + opts.cls : '');
  d.innerHTML = `<span class="n">${rankOf(k)}</span><span class="s">${SUIT_CN[suitOf(k)]}</span>`;
  d.title = opts.title || tileCN(k);
  if (opts.onClick) { d.classList.add('click'); d.addEventListener('click', opts.onClick); }
  d.dataset.tile = k;
  return d;
}
const relName = s => seatName(s, ME);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/* ---------- 对局流程 ---------- */
function newGame() {
  clearTimeout(S.timer);
  stopLLM();
  const seedText = $('#seed').value.trim();
  const seed = seedText || String(Math.floor(Math.random() * 1e9));
  S.g = createGame({ seed, dealer: S.dealer, rules: { exchangeThree: S.exchange } });
  S.g.seedText = seed;
  S.bots = [null, 1, 2, 3].map(i => i && createBot(S.level, S.g.seed * 7 + i));
  S.selected = []; S.feedback = null; S.explainedSeq = -1;
  $('#result').hidden = true;
  $('#llmWarn').textContent = '';
  $('#llmOut').innerHTML = '<span class="hint">在你的回合点「讲解这一手」。</span>';
  $('#reasonBox').hidden = true;
  refresh();
  pump();
}

/* 电脑按节奏一步一步走；轮到人类或结束时停下 */
function pump() {
  clearTimeout(S.timer);
  const g = S.g;
  if (g.phase === 'end') return onEnd();
  const seats = Object.keys(pending(g).seats).map(Number);
  if (seats.some(s => S.bots[s])) {
    const instant = g.phase === 'exchange' || g.phase === 'void';
    S.timer = setTimeout(() => {
      runBots(g, S.bots, { stepOnce: true });
      refresh();
      pump();
    }, instant ? 0 : g.players[ME].won ? Math.min(S.speed, 120) : S.speed);   // 你胡了以后观战加速
  }
}

function act(action) {
  const g = S.g;
  if (S.analysis && action.type === 'discard' && S.analysis.candidates) {
    const mine = S.analysis.candidates.find(c => c.tile === action.tile);
    S.feedback = { mine, best: S.analysis.candidates[0], rank: S.analysis.candidates.indexOf(mine) + 1 };
  } else S.feedback = null;
  try { submit(g, ME, action); } catch (e) { alert(e.message); return; }
  S.selected = [];
  refresh();
  pump();
}

function onEnd() {
  const g = S.g;
  if (!g.countedTotals) {
    g.countedTotals = true;
    g.result.scores.forEach((v, i) => { S.totals[i] += v; });
    S.games++;
    S.dealer = g.result.winners.length ? g.result.winners[0] : S.dealer;
  }
  renderResult();
  renderTotals();
}

/* ---------- 渲染 ---------- */
function refresh() {
  const g = S.g;
  const view = viewFor(g, ME);
  S.analysis = (g.phase === 'end' || g.phase === 'exchange' || g.phase === 'void') ? null : analyze(view);
  for (let s = 1; s < 4; s++) renderOpp(view, s);
  renderMe(view);
  renderCenter(view);
  renderAnalysis(view);
  renderLog(view);
  updateExplainButton(view);
}

function renderOpp(view, s) {
  const p = view.players[s];
  const el = $('#seat' + s);
  const g = S.g;
  el.className = el.className.replace(/ ?(turn|won)/g, '') + (view.turn === s ? ' turn' : '') + (p.won ? ' won' : '');
  const opp = S.analysis && S.analysis.opponents.find(o => o.seat === s);
  const head = document.createElement('h3');
  head.innerHTML = `${esc(relName(s))}<span class="badge">${LEVEL_NAME[S.level]}</span>` +
    (s === g.dealer ? '<span class="badge">庄</span>' : '') +
    (p.voidSuit !== null ? `<span class="badge void">缺${SUIT_CN[p.voidSuit]}</span>` : '') +
    (p.won ? `<span class="badge win">第${p.won.order}胡 ${p.won.zimo ? '自摸' : '点炮'} ${p.won.fan}番</span>` : '') +
    (opp && !p.won && opp.threat >= 0.5 ? `<span class="badge threat">威胁 ${opp.threat}</span>` : '') +
    `<span class="badge">${p.score >= 0 ? '+' : ''}${p.score}</span>`;
  const hand = document.createElement('div');
  hand.className = 'river';
  // 胡牌者手牌扣着不亮，只亮胡的那张；局终摊牌，「明牌」开关只影响显示
  const full = S.reveal || g.phase === 'end' ? g.players[s].hand.slice() : null;
  const zimoTile = p.won && p.won.zimo ? p.won.tile : null;   // 自摸的胡牌在手里，单独放到「胡」后面
  if (full) {
    if (zimoTile !== null) full.splice(full.indexOf(zimoTile), 1);
    full.forEach(t => hand.appendChild(tileEl(t, { sm: true })));
  } else for (let i = 0; i < p.handCount - (zimoTile !== null ? 1 : 0); i++) hand.appendChild(tileEl(null, { sm: true }));
  if (p.won) { hand.appendChild(document.createTextNode(' 胡 ')); hand.appendChild(tileEl(p.won.tile, { sm: true, cls: 'huby' })); }
  el.replaceChildren(head, hand, meldsEl(p.melds, true), riverEl(view, p));
}

function meldsEl(melds, sm) {
  const box = document.createElement('div');
  box.className = 'melds';
  for (const m of melds) {
    const d = document.createElement('div');
    d.className = 'meld';
    d.title = m.kind === 'pong' ? '碰' : ({ an: '暗杠', ming: '直杠', bu: '补杠' })[m.gangType];
    const n = m.kind === 'gang' ? 4 : 3;
    for (let i = 0; i < n; i++) d.appendChild(m.gangType === 'an' && (i === 0 || i === 3) ? tileEl(null, { sm }) : tileEl(m.tile, { sm }));
    box.appendChild(d);
  }
  return box;
}

function riverEl(view, p) {
  const box = document.createElement('div');
  box.className = 'river';
  const last = view.claim && view.claim.from === p.seat;
  p.discards.forEach((d, i) => {
    let cls = d.claimed ? 'claimed' : '';
    if (d.huBy) cls = 'huby';
    if (last && i === p.discards.length - 1) cls += ' last';
    box.appendChild(tileEl(d.tile, { sm: true, cls, title: tileCN(d.tile) + (d.claimed ? '（被碰/杠）' : d.huBy ? '（被胡）' : '') }));
  });
  return box;
}

function renderMe(view) {
  const g = S.g;
  const p = view.players[ME];
  const el = $('#seat0');
  el.className = 'seat seat-me' + (view.turn === ME ? ' turn' : '') + (p.won ? ' won' : '');
  const head = document.createElement('h3');
  head.innerHTML = `你${ME === g.dealer ? '<span class="badge">庄</span>' : ''}` +
    (p.voidSuit !== null ? `<span class="badge void">缺${SUIT_CN[p.voidSuit]}</span>` : '') +
    (p.won ? `<span class="badge win">第${p.won.order}胡 ${p.won.fan}番</span>` : '') +
    `<span class="badge">${p.score >= 0 ? '+' : ''}${p.score}</span>` +
    `<span class="hint" id="meHint"></span>`;

  const hand = document.createElement('div');
  hand.className = 'hand';
  const acts = view.actions;
  const discardable = new Set(acts.filter(a => a.type === 'discard').map(a => a.tile));
  const rec = !S.practice && S.analysis && S.analysis.recommend ? S.analysis.recommend.tile : null;
  const tiles = p.hand.slice();
  let drawn = view.drawn;
  if (drawn !== null && drawn !== undefined) tiles.splice(tiles.indexOf(drawn), 1);
  else drawn = null;
  const exchanging = g.phase === 'exchange' && acts.length;
  const mk = (t, idx) => {
    const isSel = exchanging && S.selected.includes(idx);
    const cls = [suitOf(t) === p.voidSuit ? 'void' : '', t === rec ? 'rec' : '', isSel ? 'sel' : ''].join(' ');
    let onClick = null;
    if (exchanging) onClick = () => toggleExchange(idx, p.hand);
    else if (discardable.has(t)) onClick = () => act({ type: 'discard', tile: t });
    const e = tileEl(t, { cls, onClick, title: tileCN(t) + (suitOf(t) === p.voidSuit ? '（缺门）' : '') });
    if (!exchanging && acts.length && g.phase === 'turn' && !discardable.has(t)) e.classList.add('dimmed');
    return e;
  };
  // 换三张阶段按原手牌下标选择（同一种牌可能有多张）
  if (exchanging) p.hand.forEach((t, i) => hand.appendChild(mk(t, i)));
  else {
    tiles.forEach(t => hand.appendChild(mk(t)));
    if (drawn !== null) { const gap = document.createElement('span'); gap.className = 'gap'; hand.appendChild(gap); hand.appendChild(mk(drawn)); }
  }
  if (p.won) { hand.appendChild(document.createTextNode(' 胡 ')); hand.appendChild(tileEl(p.won.tile, { cls: 'huby' })); }

  el.replaceChildren(head, meldsEl(p.melds, false), hand, actionsEl(view));
}

function toggleExchange(idx, hand) {
  const i = S.selected.indexOf(idx);
  if (i >= 0) S.selected.splice(i, 1);
  else {
    if (S.selected.length && suitOf(hand[S.selected[0]]) !== suitOf(hand[idx])) S.selected = [];
    if (S.selected.length < 3) S.selected.push(idx);
  }
  refresh();
}

function btn(text, cls, onClick, title) {
  const b = document.createElement('button');
  b.textContent = text;
  if (cls) b.className = cls;
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function actionsEl(view) {
  const g = S.g;
  const box = document.createElement('div');
  box.className = 'actions';
  const acts = view.actions;
  const me = view.players[ME];
  const hint = document.createElement('span');
  hint.className = 'hint';
  if (!acts.length) {
    hint.textContent = g.phase === 'end' ? '本局结束' : me.won ? '你已胡牌，观战中…' : '等待其他玩家…';
    box.appendChild(hint);
    return box;
  }
  if (g.phase === 'exchange') {
    const advice = decide(createBot(3, 1), view);
    box.appendChild(btn(`确认换出（${S.selected.length}/3）`, 'primary', () => {
      if (S.selected.length !== 3) return alert('请选同一花色的 3 张牌');
      act({ type: 'exchange', tiles: S.selected.map(i => me.hand[i]) });
    }));
    box.appendChild(btn('按建议选', '', () => {
      const used = new Set();
      S.selected = advice.tiles.map(t => { const i = me.hand.findIndex((x, j) => x === t && !used.has(j)); used.add(i); return i; });
      refresh();
    }, '高手电脑的选择：张数最少的一门里，对牌效影响最小的 3 张'));
    hint.textContent = '换三张：点选同一花色的 3 张牌';
    box.appendChild(hint);
    return box;
  }
  if (g.phase === 'void') {
    const advice = decide(createBot(3, 1), view).suit;
    for (const a of acts) {
      const n = me.hand.filter(t => suitOf(t) === a.suit).length;
      box.appendChild(btn(`缺${SUIT_CN[a.suit]}（${n} 张）`, a.suit === advice && !S.practice ? 'on' : '', () => act(a)));
    }
    hint.textContent = S.practice ? '定缺：选一门不要的花色' : `定缺建议：缺${SUIT_CN[advice]}（张数 → 剩余向听 → 有效牌 → 好形）`;
    box.appendChild(hint);
    return box;
  }
  const label = { hu: '胡', pong: '碰', minggang: '杠', pass: '过', angang: '暗杠', bugang: '补杠' };
  for (const a of acts) {
    if (a.type === 'discard') continue;
    const text = label[a.type] + (a.tile !== undefined ? ' ' + tileCN(a.tile) : '');
    box.appendChild(btn(text, a.type === 'hu' ? 'hot' : a.type === 'pass' ? '' : 'primary', () => act(a)));
  }
  if (g.phase === 'turn') {
    hint.textContent = me.hand.some(t => suitOf(t) === me.voidSuit) ? '手里还有缺门牌，必须先打缺门' : '点一张牌打出';
  } else {
    hint.textContent = `${relName(view.claim ? view.claim.from : view.rob.seat)}${view.rob ? '补杠' : '打出'} ${tileCN(view.claim ? view.claim.tile : view.rob.tile)}`;
  }
  box.appendChild(hint);
  return box;
}

function renderCenter(view) {
  const g = S.g;
  const el = $('#center');
  const status = g.phase === 'end' ? '本局结束'
    : g.phase === 'exchange' ? '换三张' : g.phase === 'void' ? '定缺'
    : g.phase === 'claim' ? `等待响应 ${tileCN(g.claim.tile)}`
    : g.phase === 'robGang' ? '抢杠？' : `轮到${relName(g.turn)}`;
  const last = [...view.log].reverse().find(e => e.type === 'discard');
  el.innerHTML = `<div><b>${esc(status)}</b></div><div class="hint">牌墙剩 ${view.wallCount} 张 · 第 ${S.games + 1} 局 · 种子 ${esc(g.seedText)}</div>`;
  const ex = view.log.find(e => e.type === 'exchange');
  if (ex && ex.got) {
    const d = document.createElement('div');
    d.className = 'hint';
    d.textContent = `换三张：${({ next: '换给下家', prev: '换给上家', opposite: '和对家换' })[ex.dir]}，换出 ${ex.gave.map(tileCN).join(' ')}，换入 ${ex.got.map(tileCN).join(' ')}`;
    el.appendChild(d);
  }
  if (last && g.phase !== 'end') {
    const d = document.createElement('div');
    d.className = 'bar';
    d.style.justifyContent = 'center';
    d.append(`${relName(last.seat)}打出 `, tileEl(last.tile, { cls: 'last' }));
    el.appendChild(d);
  }
}

function renderAnalysis(view) {
  const el = $('#analysis');
  const a = S.analysis;
  const parts = ['<div class="bar" style="justify-content:space-between"><b style="font-size:13px">局势分析（程序计算）</b>'];
  parts.push(a && a.stance ? `<span class="badge">${({ attack: '进攻', balance: '对手有威胁', fold: '对手威胁高' })[a.stance]}</span>` : '');
  parts.push('</div>');
  if (S.feedback && S.feedback.mine) {
    const f = S.feedback;
    const same = f.mine.tile === f.best.tile;
    parts.push(`<div class="alert ${same ? 'key' : 'warn'}">上一手：你打 ${tileCN(f.mine.tile)}（第 ${f.rank} 名，向听 ${f.mine.shanten}，有效牌 ${f.mine.ukeireTotal}）` +
      (same ? ' ✓ 与推荐一致' : `；推荐打 ${tileCN(f.best.tile)}（向听 ${f.best.shanten}，有效牌 ${f.best.ukeireTotal}，危险 ${f.best.danger}）`) + '</div>');
  }
  if (!a) {
    const tip = S.g.phase === 'end' ? '本局结束，结果见左侧。' : '换三张 / 定缺阶段见手牌下方的建议。';
    el.innerHTML = parts.join('') + `<div class="hint">${tip}</div>`;
    return;
  }
  if (a.alerts.length) parts.push('<div class="alerts">' + a.alerts.map(x => `<div class="alert ${x.level}">${esc(x.text)}</div>`).join('') + '</div>');
  if (a.candidates) {
    const hide = S.practice;
    parts.push(`<table class="cand"><tr><th>打出</th><th>向听</th><th>有效牌</th><th>危险（估）</th>${hide ? '' : '<th>综合</th>'}</tr>`);
    a.candidates.slice(0, 8).forEach((c, i) => {
      const uk = c.ukeire.filter(u => u.remain > 0).map(u => `${tileCN(u.tile)}×${u.remain}`).join(' ');
      const waits = c.waits ? '听 ' + c.waits.map(w => `${tileCN(w.tile)}(${w.remain}张/${w.fan}番)`).join(' ') : '';
      const mc = !hide && c.mc ? `模拟：和牌率 ${Math.round(c.mc.winRate * 100)}%，期望 ${c.mc.ev} 分` : '';
      const odds = !hide && c.ev !== undefined ? (c.pHu !== undefined ? `和牌率约 ${Math.round(c.pHu * 100)}%` : `来得及听牌约 ${Math.round(c.pReach * 100)}%`) : '';
      parts.push(`<tr class="${!hide && i === 0 ? 'best' : ''}" data-tile="${c.tile}"><td>${c.id} ${tileCN(c.tile)}</td><td>${c.shanten}</td>` +
        `<td title="${esc(uk)}">${c.ukeireTotal} 张${waits ? '<br><span class="hint">' + esc(waits) + '</span>' : ''}${odds ? '<br><span class="hint">' + esc(odds) + '</span>' : ''}${mc ? '<br><span class="hint" title="只模拟自己往后的摸打，是估计值">' + esc(mc) + '</span>' : ''}</td>` +
        `<td><span class="dbar" style="width:${Math.round(c.danger * 60) + 2}px"></span> ${c.danger}</td>${hide ? '' : `<td>${c.ev !== undefined ? `<span title="本局剩余部分的期望得分（底分），按自对弈牌谱拟合">期望 ${c.ev >= 0 ? '+' : ''}${c.ev.toFixed(2)}</span>` : c.score}</td>`}</tr>`);
    });
    parts.push('</table>');
    if (hide) parts.push('<div class="hint">练习模式：已隐藏推荐与综合分，出牌后显示对照。</div>');
  }
  if (a.claim) {
    const o = a.claim.options, b = a.claim.before;
    const evTxt = v => (v === undefined || S.practice ? '' : `，期望 ${v >= 0 ? '+' : ''}${v.toFixed(2)}`);
    parts.push(`<div class="alert">不动：向听 ${b.shanten}，有效牌 ${b.ukeireTotal} 张${evTxt(a.claim.evPass)}</div>`);
    if (o.hu) parts.push(`<div class="alert key">胡：${o.hu.fan} 番 ${o.hu.points} 分（${o.hu.yaku.map(k => FAN_LABEL[k] || k).join('、')}）</div>`);
    if (o.pong) parts.push(`<div class="alert">碰后打 ${tileCN(o.pong.discard)}：向听 ${o.pong.shanten}，有效牌 ${o.pong.ukeireTotal} 张` +
      (o.pong.ev === undefined || S.practice ? '' : o.pong.evDiscard === o.pong.discard ? evTxt(o.pong.ev) : `；按期望得分碰后打 ${tileCN(o.pong.evDiscard)}${evTxt(o.pong.ev)}`) + '</div>');
    if (o.minggang) parts.push(`<div class="alert">杠：向听 ${o.minggang.shanten}，有效牌 ${o.minggang.ukeireTotal} 张，直杠收 2 分${evTxt(o.minggang.ev)}</div>`);
  }
  parts.push('<div style="margin-top:8px">' + a.opponents.map(o =>
    `<div class="opp"><b>${esc(relName(o.seat))}</b>` +
    (o.won ? '<span class="badge win">已胡</span>' : `<span class="meter"><i style="width:${Math.round(o.threat * 100)}%"></i></span> 威胁 ${o.threat}`) +
    (o.voidSuit !== null ? ` · 缺${SUIT_CN[o.voidSuit]}${o.voidCleared ? '（已打完）' : ''}` : '') +
    (o.suspectSuit !== null ? ` · 疑似清一色${SUIT_CN[o.suspectSuit]}` : '') +
    (!o.won && o.reasons.length ? ` <span class="hint">${esc(o.reasons.join('、'))}</span>` : '') + '</div>').join('') + '</div>');
  parts.push('<div class="hint" style="margin-top:6px">危险度（放炮概率）与威胁（听牌概率）是用电脑自对弈牌谱训练的模型估计，对真人对手可能偏差；对手缺门花色的牌对他绝对安全。「模拟」是随机补全未知牌后的和牌率与期望得分估计，不参与排序。听牌 / 一向听时按「期望」排序：本局剩余部分的期望得分（底分），由自对弈牌谱拟合的和牌率与胡牌收入估计，排在综合分候选前面。</div>');
  el.innerHTML = parts.join('');
  el.querySelectorAll('tr[data-tile]').forEach(tr => {
    const t = tr.dataset.tile;
    tr.addEventListener('mouseenter', () => document.querySelectorAll(`#seat0 .hand .tile[data-tile="${t}"]`).forEach(x => x.classList.add('hl')));
    tr.addEventListener('mouseleave', () => document.querySelectorAll('#seat0 .tile.hl').forEach(x => x.classList.remove('hl')));
  });
}

const PAY_REASON = { zimo: '自摸', dianPao: '点炮', qiangGang: '抢杠', gang: '杠', callTransfer: '呼叫转移', huazhu: '查花猪', dajiao: '查大叫', taxRefund: '退税' };
function logLine(e) {
  const n = s => relName(s);
  switch (e.type) {
    case 'start': return `开局，庄家：${n(e.dealer)}`;
    case 'exchange': return `换三张（${({ next: '给下家', prev: '给上家', opposite: '对家互换' })[e.dir]}）`;
    case 'void': return '定缺：' + e.suits.map((s, i) => `${n(i)}缺${SUIT_CN[s]}`).join('，');
    case 'draw': return null;
    case 'discard': return `${n(e.seat)} 打 ${tileCN(e.tile)}`;
    case 'pong': return `${n(e.seat)} 碰 ${tileCN(e.tile)}`;
    case 'gang': return `${n(e.seat)} ${({ an: '暗杠', ming: '直杠', bu: '补杠' })[e.gangType]} ${tileCN(e.tile)}`;
    case 'bugangDeclare': return `${n(e.seat)} 补杠 ${tileCN(e.tile)}（等待抢杠）`;
    case 'robbed': return `${n(e.seat)} 的补杠被抢`;
    case 'hu': return `★ ${n(e.seat)} ${e.zimo ? '自摸' : '胡'} ${tileCN(e.tile)}，${e.fan} 番 ${e.points} 分（${e.yaku.map(y => FAN_LABEL[y.key] + (y.times > 1 ? '×' + y.times : '')).join('、')}）`;
    case 'pay': return `  ${n(e.from)} → ${n(e.to)} ${e.amount} 分（${PAY_REASON[e.reason] || e.reason}）`;
    case 'end': return `本局结束（${e.reason === 'wall' ? '流局' : '三家已胡'}）`;
  }
  return null;
}

function renderLog(view) {
  const lines = view.log.map(logLine).filter(Boolean);
  const el = $('#log');
  el.innerHTML = lines.slice(-80).map(esc).join('<br>');
  el.scrollTop = el.scrollHeight;
}

function renderResult() {
  const g = S.g;
  const el = $('#result');
  const rows = g.players.map(p => {
    const w = p.won;
    const desc = w ? `第${w.order}胡 · ${w.zimo ? '自摸' : '点炮'} ${tileCN(w.tile)} · ${w.fan} 番（${w.yaku.map(y => FAN_LABEL[y.key] + (y.times > 1 ? '×' + y.times : '')).join('、')}）` : '未胡';
    const sc = g.result.scores[p.seat];
    return `<tr><td>${esc(relName(p.seat))}</td><td>${esc(desc)}</td><td class="${sc > 0 ? 'pos' : sc < 0 ? 'neg' : ''}">${sc > 0 ? '+' : ''}${sc}</td><td>${S.totals[p.seat]}</td></tr>`;
  }).join('');
  const settle = g.result.settle.map(x => `${relName(x.from)} → ${relName(x.to)} ${x.amount} 分（${PAY_REASON[x.type]}）`).join('；');
  el.innerHTML = `<b>本局结果（${g.result.reason === 'wall' ? '流局' : '三家已胡'}）</b>` +
    `<table><tr><th>座位</th><th>胡牌</th><th>本局</th><th>累计</th></tr>${rows}</table>` +
    (settle ? `<div class="hint" style="margin-top:6px">流局结算：${esc(settle)}</div>` : '') +
    '<div class="bar" style="margin-top:8px"></div>';
  el.querySelector('.bar').appendChild(btn('下一局', 'primary', () => { $('#seed').value = ''; newGame(); }));
  el.querySelector('.bar').appendChild(btn('下载牌谱', '', downloadRecord, '保存本局可重放的 JSON 牌谱（复盘 / 统计用）'));
  el.hidden = false;
}

/* 牌谱：种子 + 规则 + 每个决定，格式见 docs/game-record.md */
function downloadRecord() {
  const g = S.g;
  const players = S.bots.map(b => (b ? { kind: 'bot', level: b.level, opts: b.opts } : { kind: 'human' }));
  const rec = exportRecord(g, { players, seedText: g.seedText });
  const url = URL.createObjectURL(new Blob([JSON.stringify(rec)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `xuezhan-${rec.createdAt.replace(/[:.]/g, '-')}-${String(g.seedText || g.seed).replace(/[^\w-]/g, '_')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderTotals() {
  $('#totalScore').textContent = S.games ? `已打 ${S.games} 局 · 累计：` + S.totals.map((v, i) => `${relName(i)} ${v >= 0 ? '+' : ''}${v}`).join('  ') : '';
}

/* ---------- AI 讲解 ---------- */
function llmReady() {
  const c = S.llm;
  return !!(c.model && (c.baseURL || c.viaProxy) && (c.apiKey || c.provider === 'custom'));
}

function updateExplainButton(view) {
  const b = $('#explain');
  const can = !!S.analysis && llmReady() && !S.llmAbort;
  b.disabled = !can;
  const key = S.analysis && view.actions.length && isKeyMoment(S.analysis);
  b.classList.toggle('pulse', !!key && can);
  b.classList.toggle('hot', !!key && can);
  b.classList.toggle('primary', !(key && can));
  $('#llmStatus').textContent = llmReady() ? `${providerById(S.llm.provider).name} · ${S.llm.model}` : '未配置（展开下方「服务商设置」）';
  if (key && can && S.llm.autoKey && S.explainedSeq !== S.g.log.length) explain();
}

function renderMd(text) {
  const lines = esc(text).split(/\r?\n/);
  const out = [];
  let list = false;
  for (let l of lines) {
    l = l.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/^#{1,6}\s*(.+)$/, '<b>$1</b>');
    const m = l.match(/^\s*[-*•]\s+(.*)$/);
    if (m) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${m[1]}</li>`); continue; }
    if (list) { out.push('</ul>'); list = false; }
    if (l.trim()) out.push(`<p>${l}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
}

function cfgForClient() {
  const c = S.llm;
  return { baseURL: c.baseURL, apiKey: c.apiKey, model: c.model, viaProxy: c.viaProxy, sessionId: S.sessionId };
}

async function explain() {
  if (!S.analysis || S.llmAbort) return;
  if (S.llm.viaProxy && location.protocol === 'file:') {
    $('#llmOut').innerHTML = '<span class="bad">经本地代理需要用 <code>node server.js</code> 启动后，从 http://127.0.0.1:5173/table.html 打开。</span>';
    return;
  }
  S.explainedSeq = S.g.log.length;
  const analysis = S.analysis;
  const msgs = buildMessages(analysis, S.g.rules, { detail: S.llm.detail, question: $('#question').value.trim() });
  const out = $('#llmOut'), reason = $('#llmReason');
  out.innerHTML = '<span class="hint">思考中…</span>';
  reason.textContent = '';
  $('#reasonBox').hidden = true;
  $('#llmWarn').textContent = '';
  const ac = new AbortController();
  S.llmAbort = ac;
  $('#stopLLM').hidden = false;
  updateExplainButton(viewFor(S.g, ME));
  let text = '';
  try {
    const r = await chatStream(cfgForClient(), msgs, {
      signal: ac.signal,
      maxTokens: S.llm.detail === 'deep' ? 1600 : 900,
      onDelta: d => { text += d; out.innerHTML = renderMd(text); out.scrollTop = out.scrollHeight; },
      onReasoning: d => { $('#reasonBox').hidden = false; reason.textContent += d; reason.scrollTop = reason.scrollHeight; }
    });
    if (!r.text) out.innerHTML = '<span class="warn">模型没有返回正文（可能只输出了思考过程或被截断），请重试或换模型。</span>';
    const v = validateExplanation(r.text, analysis);
    const tips = [...v.warnings];
    if (r.finish === 'length') tips.push('输出被长度截断，可改用「简短」');
    $('#llmWarn').textContent = tips.join('；');
  } catch (e) {
    if (e.name === 'AbortError') out.innerHTML += '<p class="hint">（已停止）</p>';
    else out.innerHTML = `<span class="bad">${esc(e.message)}</span>`;
  } finally {
    S.llmAbort = null;
    $('#stopLLM').hidden = true;
    updateExplainButton(viewFor(S.g, ME));
  }
}

function stopLLM() {
  if (S.llmAbort) S.llmAbort.abort();
}

function applyProvider(id, keepFields) {
  const p = providerById(id);
  S.llm.provider = p.id;
  if (!keepFields) {
    S.llm.baseURL = p.baseURL;
    S.llm.model = p.model || '';
    S.llm.viaProxy = !p.cors;
  }
  $('#provider').value = p.id;
  $('#baseURL').value = S.llm.baseURL;
  $('#baseURL').readOnly = p.id !== 'custom';
  $('#model').value = S.llm.model;
  $('#model').placeholder = p.modelHint || '';
  $('#viaProxy').checked = S.llm.viaProxy;
  $('#viaProxy').disabled = !p.cors;      // 不支持跨域的服务商只能走代理
  const notes = [];
  if (p.note) notes.push(p.note);
  if (S.llm.viaProxy && location.protocol === 'file:') notes.push('当前是 file:// 打开，代理不可用：请运行 node server.js 后访问 http://127.0.0.1:5173/table.html');
  $('#providerNote').textContent = notes.join(' ');
}

function bindLLMSettings() {
  const sel = $('#provider');
  sel.innerHTML = PROVIDERS.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  applyProvider(S.llm.provider, !!S.llm.baseURL || S.llm.provider === 'custom');
  $('#apiKey').value = S.llm.apiKey;
  $('#rememberKey').checked = S.llm.remember;
  $('#detail').value = S.llm.detail;
  $('#autoKey').checked = S.llm.autoKey;
  const changed = () => { saveSettings(); if (S.g) updateExplainButton(viewFor(S.g, ME)); };
  sel.addEventListener('change', () => { applyProvider(sel.value, false); changed(); });
  $('#baseURL').addEventListener('input', e => { S.llm.baseURL = e.target.value.trim(); changed(); });
  $('#model').addEventListener('input', e => { S.llm.model = e.target.value.trim(); changed(); });
  $('#apiKey').addEventListener('input', e => { S.llm.apiKey = e.target.value.trim(); changed(); });
  $('#rememberKey').addEventListener('change', e => { S.llm.remember = e.target.checked; changed(); });
  $('#viaProxy').addEventListener('change', e => { S.llm.viaProxy = e.target.checked; applyProvider(S.llm.provider, true); changed(); });
  $('#detail').addEventListener('change', e => { S.llm.detail = e.target.value; changed(); });
  $('#autoKey').addEventListener('change', e => { S.llm.autoKey = e.target.checked; changed(); });
  $('#clearKey').addEventListener('click', () => {
    S.llm.apiKey = ''; $('#apiKey').value = '';
    store.del(localStorage, KKEY); store.del(sessionStorage, KKEY);
    changed();
  });
  $('#fetchModels').addEventListener('click', async () => {
    const b = $('#fetchModels');
    b.disabled = true; b.textContent = '获取中…';
    try {
      const ms = await listModels(cfgForClient());
      $('#modelList').innerHTML = ms.map(m => `<option value="${esc(m)}">`).join('');
      b.textContent = `共 ${ms.length} 个`;
      if (!S.llm.model && ms.length) { S.llm.model = ms[0]; $('#model').value = ms[0]; changed(); }
    } catch (e) {
      alert('获取模型失败：' + e.message);
      b.textContent = '获取模型';
    } finally { b.disabled = false; }
  });
  $('#testLLM').addEventListener('click', async () => {
    const out = $('#llmOut');
    out.innerHTML = '<span class="hint">测试中…</span>';
    try {
      const r = await chatStream(cfgForClient(), [{ role: 'user', content: '只回复两个字：连通' }], { maxTokens: 300 });
      out.innerHTML = `<span class="ok">连接成功</span>：${esc(r.text || '(无正文)')}`;
    } catch (e) { out.innerHTML = `<span class="bad">${esc(e.message)}</span>`; }
  });
  $('#explain').addEventListener('click', explain);
  $('#stopLLM').addEventListener('click', stopLLM);
}

/* ---------- 顶部设置 ---------- */
function bindTopBar() {
  const lv = $('#level'), sp = $('#speed');
  lv.value = String(S.level); sp.value = String(S.speed);
  const toggles = [['#optExchange', 'exchange'], ['#optPractice', 'practice'], ['#optReveal', 'reveal']];
  for (const [id, k] of toggles) {
    const b = $(id);
    b.classList.toggle('on', !!S[k]);
    b.addEventListener('click', () => {
      S[k] = !S[k]; b.classList.toggle('on', S[k]); saveSettings();
      if (S.g && k !== 'exchange') refresh();
    });
  }
  lv.addEventListener('change', () => {
    S.level = +lv.value; saveSettings();
    if (S.g) { S.bots = [null, 1, 2, 3].map(i => i && createBot(S.level, S.g.seed * 7 + i)); refresh(); }
  });
  sp.addEventListener('change', () => { S.speed = +sp.value; saveSettings(); });
  $('#newGame').addEventListener('click', newGame);
}

loadSettings();
bindTopBar();
bindLLMSettings();
newGame();
