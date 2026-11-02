/**
 * 住宅 ProxyIP 订阅重写 Worker
 *
 * 两种用法：
 *
 *   A. 订阅重写（推荐，填一次永不再改）
 *      https://xxx.workers.dev/sub?url=<原始订阅>&token=xxx
 *      每次 Clash 更新订阅时，Worker 现场挑选住宅 IP 并注入节点 path。
 *
 *   B. 直接查询列表
 *      https://xxx.workers.dev/           纯文本 IP 列表
 *      https://xxx.workers.dev/best       单个 IP:443
 *      https://xxx.workers.dev/json       带分数的完整 JSON
 *
 * 免费版限额对策（这是关键）：
 *   - 单请求 50 个子请求 → 扫描拆成多轮 cron，每轮只处理一小批
 *   - 6 个并发出站连接 → 并发上限设 4，留余量
 *   - 10ms CPU → 只做字符串比较，不解析大对象
 *   - 结果存 KV，/sub 只读 KV，几乎零开销
 */

import {
  scoreIP,
  injectProxyIP,
  injectLinkList,
  looksLikeLinkList,
  extractProxyIPs,
} from './lib.js';

const DOH = 'https://dns.alidns.com/resolve';
const IPAPI = 'http://ip-api.com/batch?fields=query,status,countryCode,isp,as,proxy,hosting,mobile';

const CONCURRENCY = 4;          // 免费版上限 6，留 2 个余量
const BATCH_PER_RUN = 24;       // 每轮 cron 最多处理的 IP 数（控制在 50 子请求内）
const DEFAULT_DOMAINS = 'proxyip.us.fxxk.dedyn.io,HKG.ProxyIP.CMLiussss.net,ICN.ProxyIP.CMLiussss.net,ProxyIP.SG.CMLiussss.net';
const MIN_SCORE = 20;
const CACHE_KEY = 'state';

function text(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      ...extra,
    },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/** 单次 DoH，超时 6 秒 */
async function doh(name, type) {
  const res = await fetch(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`doh ${res.status}`);
  return res.json();
}

/** 解析域名的 A 记录 */
async function resolveA(domain) {
  try {
    const r = await doh(domain, 'A');
    if (!Array.isArray(r.Answer)) return [];
    return r.Answer.filter((a) => a.type === 1 && /^\d+\.\d+\.\d+\.\d+$/.test(a.data)).map((a) => a.data);
  } catch {
    return [];
  }
}

/** 解析 PTR，失败返回空串 */
async function resolvePTR(ip) {
  try {
    const arpa = `${ip.split('.').reverse().join('.')}.in-addr.arpa`;
    const r = await doh(arpa, 'PTR');
    if (Array.isArray(r.Answer)) {
      const hit = r.Answer.find((a) => a.type === 12);
      if (hit) return String(hit.data).replace(/\.$/, '').toLowerCase();
    }
    return '';
  } catch {
    return '';
  }
}

/** 分批并发执行，控制并发数 */
async function mapLimit(items, limit, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const got = await Promise.all(chunk.map(fn));
    results.push(...got);
  }
  return results;
}

/**
 * 一轮增量扫描。
 * state: { pool: string[], cursor: number, residential: object[], lastRun }
 * 只处理 BATCH_PER_RUN 个 IP，保证不超子请求限额。
 */
async function scanRound(env, state) {
  const domains = String(env.PROXYIP_DOMAINS || DEFAULT_DOMAINS)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // 池子为空时先解析域名（域名少，开销小）
  let pool = state.pool || [];
  if (pool.length === 0) {
    const lists = await mapLimit(domains, CONCURRENCY, resolveA);
    pool = [...new Set(lists.flat())];
    state.cursor = 0;
  }

  if (pool.length === 0) {
    return { ...state, pool: [], ok: false, error: '域名解析失败' };
  }

  // 取本批要处理的 IP
  const start = (state.cursor || 0) % pool.length;
  const batch = [];
  for (let i = 0; i < BATCH_PER_RUN && i < pool.length; i++) {
    batch.push(pool[(start + i) % pool.length]);
  }

  // PTR（每个 1 子请求）
  const ptrs = await mapLimit(batch, CONCURRENCY, (ip) => resolvePTR(ip));

  // ip-api 批量（1 子请求）
  let asnMap = new Map();
  try {
    const res = await fetch(IPAPI, {
      method: 'POST',
      body: JSON.stringify(batch.map((q) => ({ query: q }))),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      for (const item of await res.json()) {
        if (item.status === 'success') asnMap.set(item.query, item);
      }
    }
  } catch {
    /* 降级：仅 PTR 判定 */
  }

  // 打分
  const minScore = Number(env.MIN_SCORE ?? MIN_SCORE);
  const found = [];
  for (let i = 0; i < batch.length; i++) {
    const ip = batch[i];
    const ptr = ptrs[i] || '';
    const info = asnMap.get(ip) || null;
    const { score, reasons } = scoreIP(ptr, info);
    if (score >= minScore) {
      found.push({
        ip,
        ptr,
        isp: info?.isp || '',
        as: info?.as || '',
        country: info?.countryCode || '',
        score,
        reasons,
      });
    }
  }

  // 合并进已有结果（同一 IP 保留最高分）
  const merged = new Map();
  for (const item of [...(state.residential || []), ...found]) {
    const old = merged.get(item.ip);
    if (!old || item.score > old.score) merged.set(item.ip, item);
  }
  const residential = [...merged.values()].sort((a, b) => b.score - a.score);

  return {
    ...state,
    pool,
    cursor: (start + BATCH_PER_RUN) % pool.length,
    residential,
    ok: true,
    lastRun: new Date().toISOString(),
    scanned: (state.scanned || 0) + batch.length,
  };
}

async function loadState(env) {
  if (!env.CACHE) return { pool: [], cursor: 0, residential: [] };
  try {
    const raw = await env.CACHE.get(CACHE_KEY);
    return raw ? JSON.parse(raw) : { pool: [], cursor: 0, residential: [] };
  } catch {
    return { pool: [], cursor: 0, residential: [] };
  }
}

/** 状态是否有实质变化（忽略 lastRun / scanned 这类每次必然不同的字段） */
function stateChanged(a, b) {
  if (!a) return true;
  const key = (s) => JSON.stringify({
    pool: s.pool || [],
    cursor: s.cursor || 0,
    residential: (s.residential || []).map((r) => [r.ip, r.score]),
  });
  return key(a) !== key(b);
}

async function saveState(env, state, prev) {
  if (!env.CACHE) return;
  // 结果没变就不写，省 KV 写入额度（免费版 1000 次/天）
  if (!stateChanged(prev, state)) return;
  await env.CACHE.put(CACHE_KEY, JSON.stringify(state), { expirationTtl: 172800 });
}

/** 读取已缓存的住宅 IP（不触发扫描） */
async function cachedHosts(env, withPort = true) {
  const state = await loadState(env);
  const port = env.OUTPUT_PORT || '443';
  return (state.residential || []).map((r) => (port ? `${r.ip}:${port}` : r.ip));
}

/** 保留路径，不当作订阅 key 处理 */
const RESERVED = new Set(['', 'sub', 'json', 'best', 'refresh', 'health', 'favicon.ico']);

/** 上游订阅面板域名（不是本 Worker 的部署域名） */
const DEFAULT_UPSTREAM = 'example-panel.example.com';   // 订阅面板域名，部署时用 UPSTREAM 变量覆盖

/** 本 Worker 自己的主机名，用于检测自环配置 */
function isSelfLoop(targetUrl, request) {
  try {
    return new URL(targetUrl).hostname.toLowerCase() === new URL(request.url).hostname.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * 拉取上游订阅，识别 YAML / base64 链接列表，注入后返回 Response。
 */
async function fetchAndInject(request, url, hosts, extraHeaders = {}) {
  const ua = request.headers.get('user-agent') || 'clash-verge/v2.0.0';

  if (isSelfLoop(url, request)) {
    return text(
      [
        '# 配置错误：UPSTREAM 指向了本 Worker 自身，会无限自环',
        `# 当前值: ${url}`,
        '# 请把 UPSTREAM 改成订阅面板域名（UPSTREAM 变量），或访问',
        `#   ${new URL(request.url).origin}/sub?url=<完整上游地址>&token=<TOKEN>`,
      ].join('\n'),
      500,
    );
  }

  let upstream;
  try {
    upstream = await fetch(url, {
      headers: {
        'user-agent': ua,
        accept: request.headers.get('accept') || '*/*',
      },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    return text(`# 拉取上游订阅失败: ${e.message}\n# 目标: ${url}`, 502);
  }
  if (!upstream.ok) {
    return text(`# 上游返回 ${upstream.status}\n# 目标: ${url}`, 502);
  }

  const raw = await upstream.text();
  const isYaml = /^(dns|proxies|port|mixed-port|proxy-groups|rules|socks-port|allow-lan):/m.test(raw);

  // 明文 YAML → 直接注入 path
  if (isYaml) {
    return new Response(injectProxyIP(raw, hosts), {
      headers: {
        'content-type': 'text/yaml; charset=utf-8',
        'cache-control': 'no-store',
        'profile-update-interval': '6',
        'profile-web-page-url': `${new URL(request.url).origin}/`,
        'subscription-userinfo': upstream.headers.get('subscription-userinfo') || '',
        ...extraHeaders,
      },
    });
  }

  // base64 或明文链接列表（vless:// 等）→ 改 path 查询参数
  let list = raw;
  if (looksLikeLinkList(raw)) {
    list = raw;
  } else {
    try {
      list = atob(raw.replace(/\s/g, ''));
    } catch {
      return text(`# 上游格式无法识别（既不是 Clash YAML 也不是 base64 订阅）`, 502);
    }
  }

  const injected = looksLikeLinkList(list) ? injectLinkList(list, hosts) : injectProxyIP(list, hosts);
  return new Response(injected, {
    headers: {
      'content-type': looksLikeLinkList(injected)
        ? 'text/plain; charset=utf-8'
        : 'text/yaml; charset=utf-8',
      'cache-control': 'no-store',
      'profile-update-interval': '6',
      'profile-web-page-url': `${new URL(request.url).origin}/`,
      'subscription-userinfo': upstream.headers.get('subscription-userinfo') || '',
      ...extraHeaders,
    },
  });
}

/** 看起来像订阅 key：单段、只含安全字符、2-64 位 */
function looksLikeKey(pathname) {
  const seg = pathname.replace(/^\/+|\/+$/g, '');
  if (seg.includes('/')) return false;
  if (!/^[A-Za-z0-9._-]{2,64}$/.test(seg)) return false;
  return !RESERVED.has(seg.toLowerCase());
}

/**
 * 把上游订阅拉下来、注入住宅 IP 后返回。
 * key 为空表示走 env.UPSTREAM 根路径。
 */
async function proxySubscription(request, env, key, extraQuery = '') {
  const hosts = await cachedHosts(env);
  if (hosts.length === 0) {
    return text('# 尚无住宅 IP，请等待 cron 扫描完成，或先访问 /refresh?token=TOKEN', 503);
  }

  const upstreamBase = String(env.UPSTREAM || DEFAULT_UPSTREAM).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const target = `https://${upstreamBase}/${key}${extraQuery}`;
  return fetchAndInject(request, target, hosts);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const token = env.TOKEN;

    // ---- 显式 /sub：查询参数传上游 ----
    if (url.pathname === '/sub') {
      if (token && url.searchParams.get('token') !== token) {
        return text('unauthorized', 401);
      }
      const target = url.searchParams.get('url');
      if (!target) return text('missing ?url=', 400);

      const hosts = await cachedHosts(env);
      if (hosts.length === 0) return text('# 尚无住宅 IP，请等待 cron 扫描完成', 503);

      return fetchAndInject(request, target, hosts);
    }

    // ---- 状态与列表 ----
    if (url.pathname === '/json') {
      const state = await loadState(env);
      return json({
        ok: true,
        scanned: state.scanned || 0,
        poolSize: (state.pool || []).length,
        cursor: state.cursor || 0,
        lastRun: state.lastRun || null,
        upstream: env.UPSTREAM || DEFAULT_UPSTREAM,
        residential: state.residential || [],
      });
    }

    if (url.pathname === '/best') {
      const hosts = await cachedHosts(env);
      return text(hosts[0] || '');
    }

    // 手动触发一轮扫描
    if (url.pathname === '/refresh') {
      if (token && url.searchParams.get('token') !== token) {
        return text('unauthorized', 401);
      }
      const state = await loadState(env);
      const next = await scanRound(env, state);
      await saveState(env, next, state);
      return json({
        ok: next.ok,
        scanned: next.scanned || 0,
        poolSize: (next.pool || []).length,
        cursor: next.cursor,
        residential: next.residential || [],
      });
    }

    // ---- 路径直通：/<订阅key> → 上游同样的路径 ----
    // 这样把域名切过来以后，原来的 /<订阅key> 订阅地址照样能用。
    if (looksLikeKey(url.pathname)) {
      const key = url.pathname.replace(/^\/+/, '');
      // 透传除 token 以外的查询参数
      const q = new URLSearchParams(url.search);
      q.delete('token');
      const qs = q.toString();
      return proxySubscription(request, env, key, qs ? `?${qs}` : '');
    }

    // ---- 根路径：说明页 ----
    const hosts = await cachedHosts(env);
    const state = await loadState(env);
    const upstream = env.UPSTREAM || DEFAULT_UPSTREAM;
    if (url.pathname === '/' && hosts.length === 0) {
      return text(
        [
          '# 住宅 ProxyIP 订阅重写 Worker',
          `# 上游: ${upstream}`,
          '# 状态: 尚未扫描出住宅 IP',
          `# 请先访问: ${url.origin}/refresh?token=${token ? '<你的TOKEN>' : ''}`,
        ].join('\n'),
      );
    }
    if (url.pathname === '/') {
      return text(
        [
          '# 住宅 ProxyIP 列表',
          `# 上游订阅: ${upstream}`,
          `# 上次扫描: ${state.lastRun || '从未'}`,
          `# 已扫描: ${state.scanned || 0} / 池内 ${(state.pool || []).length} 个 IP`,
          `# 订阅地址: ${url.origin}/<订阅key>   (例: ${url.origin}/<订阅key>)`,
          '',
          ...hosts,
        ].join('\n'),
      );
    }

    return text('not found', 404);
  },

  /** Cron：每 5 分钟推进一小批，~25 分钟可完整扫完池子 */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const state = await loadState(env);
        const next = await scanRound(env, state);
        await saveState(env, next, state);
        console.log(
          `[cron] pool=${(next.pool || []).length} cursor=${next.cursor} residential=${(next.residential || []).length}`,
        );
      })(),
    );
  },
};
