/* 预置的 OpenAI 兼容服务商。
   cors：浏览器能否直连（2026-10 用 OPTIONS 预检实测）；不能直连的必须走 server.js 代理。
   模型名各家更新很快，这里只给示例，界面上可「获取模型列表」或手填。 */
export const PROVIDERS = [
  { id: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', cors: true, modelHint: '点「获取模型」选择' },
  { id: 'deepseek', name: 'DeepSeek', baseURL: 'https://api.deepseek.com', cors: true, model: 'deepseek-chat' },
  { id: 'openrouter', name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', cors: true, modelHint: '如 deepseek/deepseek-chat' },
  { id: 'moonshot', name: 'Moonshot (Kimi)', baseURL: 'https://api.moonshot.cn/v1', cors: true, modelHint: '点「获取模型」选择' },
  {
    id: 'opencode-go', name: 'OpenCode Go', baseURL: 'https://opencode.ai/inference/go/openai/v1', cors: false,
    model: 'deepseek-v4.1-flash',
    note: 'OpenCode Go 官方定位为「OpenCode 和其他编码 agent」使用，并监控流量；用于麻将讲解属于非典型用途，可能被判定滥用，请自行评估。只能经本地 server.js 代理访问。'
  },
  { id: 'custom', name: '自定义（OpenAI 兼容）', baseURL: '', cors: true, modelHint: '填写模型名' }
];

export function providerById(id) {
  return PROVIDERS.find(p => p.id === id) || PROVIDERS[PROVIDERS.length - 1];
}

/* 代理允许转发的目标（server.js 也用这份白名单） */
export const PROXY_TARGETS = PROVIDERS.filter(p => p.baseURL).map(p => p.baseURL);
