/* 可设种子的随机数（mulberry32）。状态是一个 uint32，存放在对局数据里，便于序列化与重放。 */
export function nextRand(holder) {
  let t = (holder.rng = (holder.rng + 0x6D2B79F5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function randInt(holder, n) {
  return Math.floor(nextRand(holder) * n);
}

export function shuffleInPlace(holder, a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(holder, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function seedFrom(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value >>> 0;
  const s = String(value ?? Date.now());
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
