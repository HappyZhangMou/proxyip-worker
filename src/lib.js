/**
 * 住宅 IP 判定逻辑（纯函数，无 Cloudflare 依赖，可在 Node 下测试）
 */

// 已知住宅/宽带 ISP 品牌（强信号）
export const RESIDENTIAL_ISP = [
  'fios', 'verizon.net', 'comcast', 'xfinity', 'charter', 'spectrum',
  'cox.net', 'centurylink', 'frontier', 'windstream', 'mediacom',
  'optimum', 'suddenlink', 'rcn.com', 'cableone', 'wowway',
  'att.net', 'sbcglobal', 'bellsouth', 'pacbell', 'ameritech',
  'btcentralplus', 'btinternet', 'sky.com', 'virginmedia', 'talktalk',
  'orange.fr', 'free.fr', 'numericable', 'sfr.fr', 'bbox.fr',
  'telefonica', 'movistar', 'vodafone', 'telia', 'telenor',
  'kddi', 'ocn.ne.jp', 'biglobe', 'plala', 'so-net', 'mesh.ad.jp',
  'softbank', 'ntt', 'hinet', 'seed.net', 'aptg', 'sparq',
  'kornet', 'kt.com', 'skbroadband', 'skbroad', 'lgpowercomm',
  'telkom', 'indihome', 'trueinternet', 'ais.co.th',
  'telstra', 'optusnet', 'iinet', 'bigpond',
  'shaw.ca', 'rogers.com', 'bell.ca', 'videotron',
];

// 住宅线索（弱信号）
export const RESIDENTIAL_HINTS = [
  'dynamic', 'dyn-ip', 'dsl', 'adsl', 'vdsl', 'pppoe', 'ppp-', 'dial',
  'broadband', 'cable', 'fiber', 'fibre', 'ftth', 'gpon',
  'residential', 'customer', 'subscriber', 'static-', 'staticip',
];

// 机房特征（一票否决）
export const HOSTING_HINTS = [
  'vps', 'vds', 'cloud', 'host', 'hosting', 'server', 'dedicated', 'dedi',
  'colo', 'datacenter', 'data-center', 'idc', 'kvm', 'openvz', 'hypervisor',
  'node', 'cluster', 'vm-', 'virtual', 'compute', 'instance',
  'digitalocean', 'linode', 'vultr', 'hetzner', 'ovh', 'contabo', 'oracle',
  'amazonaws', 'aws', 'azure', 'googleusercontent', 'alibaba', 'aliyun',
  'tencent', 'qcloud', 'zenlayer', 'colocrossing', 'fdservers',
  'hostpapa', 'hostkey', 'aceville', 'virmach',
  'racknerd', 'buyvm', 'frantech', 'ionos', 'leaseweb', 'choopa',
];

// 已知机房 ASN
export const HOSTING_ASN = new Set([
  14061, 31898, 132203, 45102, 21859, 36352, 30058, 20473, 396982,
  16509, 8075, 63949, 16276, 24940, 211273, 206264, 395839, 139341,
  40065, 35916, 35251, 26383, 214238, 402169, 35280, 49791, 8796,
  402629, 13335, 54113, 9009, 142594, 154177, 49304, 36007, 216444,
]);

export function containsAny(text, list) {
  return list.some((k) => text.includes(k));
}

/**
 * 打分：分数越高越像住宅 IP。
 * @param {string} ptr  PTR 主机名（小写，可为空）
 * @param {object|null} asnInfo  ip-api 返回的条目，可为 null
 */
export function scoreIP(ptr, asnInfo) {
  const reasons = [];
  let score = 0;

  if (ptr && containsAny(ptr, RESIDENTIAL_ISP)) {
    score += 60;
    reasons.push('PTR 命中住宅 ISP 品牌');
  }
  if (ptr && containsAny(ptr, RESIDENTIAL_HINTS)) {
    score += 20;
    reasons.push('PTR 含住宅关键词');
  }
  if (ptr && containsAny(ptr, HOSTING_HINTS)) {
    score -= 80;
    reasons.push('PTR 含机房关键词');
  }

  if (asnInfo) {
    if (asnInfo.hosting === true) {
      score -= 60;
      reasons.push('ip-api 标记 hosting');
    }
    if (asnInfo.proxy === true) {
      score -= 60;
      reasons.push('ip-api 标记 proxy');
    }
    if (asnInfo.mobile === true) {
      score += 15;
      reasons.push('移动网络');
    }
    const asnNum = Number(
      String(asnInfo.as || '').replace(/^AS/i, '').split(' ')[0],
    );
    if (Number.isFinite(asnNum) && HOSTING_ASN.has(asnNum)) {
      score -= 50;
      reasons.push(`已知机房 AS${asnNum}`);
    }
    if (asnInfo.hosting === false && asnInfo.proxy === false && !ptr) {
      score += 5;
      reasons.push('无 PTR 但未被标记');
    }
  } else if (!ptr) {
    score -= 20;
    reasons.push('缺少判定依据');
  }

  return { score, reasons };
}

/**
 * 改写单个 path 字符串，注入 proxyip。
 *
 * CM 的 path 有三种形态：
 *   /proxyip=1.1.1.1?ed=2560          ← PATH 为空
 *   /<uuid>/proxyip=1.1.1.1?ed=2560   ← 有 PATH
 *   /?ed=2560                          ← 后台开了「自动获取」，没有 proxyip
 *
 * 前两种替换，第三种插入。
 */
export function rewritePath(pathValue, host) {
  if (!pathValue) return pathValue;

  // 已有 proxyip → 替换
  if (pathValue.includes('/proxyip=')) {
    return pathValue.replace(/\/proxyip=[^?\s"'&]*/, `/proxyip=${host}`);
  }

  // 没有 proxyip → 插入到查询串之前
  const q = pathValue.indexOf('?');
  if (q >= 0) {
    let base = pathValue.slice(0, q);
    if (base.endsWith('/')) base = base.slice(0, -1);
    return `${base}/proxyip=${host}${pathValue.slice(q)}`;
  }
  let base = pathValue;
  if (base.endsWith('/')) base = base.slice(0, -1);
  return `${base}/proxyip=${host}`;
}

/** 当前时间，格式化为 UTC+8 的 `YYYY-MM-DD HH:mm:ss`（订阅注释用） */
export function cstStamp(date = new Date()) {
  const d = new Date(date.getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/**
 * 把住宅 IP 列表注入到 Clash 配置中。
 *
 * 覆盖两种 YAML 写法：
 *   xhttp-opts: {path: "/proxyip=...?ed=2560", ...}     ← 行内 flow map
 *   - path: "/proxyip=...?ed=2560"                       ← 块格式
 *
 * 不论上游 path 里是否已有 proxyip，都能正确注入。
 */
export function injectProxyIP(yaml, hosts, comment = true) {
  if (!hosts || hosts.length === 0) return yaml;

  const primary = hosts[0];
  let out = yaml;

  // 1. 行内写法：path: "/xxx"（含 flow map 与块格式，都带引号）
  out = out.replace(
    /(\bpath:\s*)(["'])([^"']*)\2/g,
    (_m, prefix, quote, value) => `${prefix}${quote}${rewritePath(value, primary)}${quote}`,
  );

  // 2. 无引号写法：path: /xxx
  out = out.replace(
    /(\bpath:\s*)(?!["'])([^\s,}\]]+)/g,
    (_m, prefix, value) => `${prefix}${rewritePath(value, primary)}`,
  );

  if (comment) {
    const stamp = cstStamp();
    const list = hosts.slice(0, 10).join(', ');
    out = `# [proxyip-worker] ${stamp} (UTC+8) 候选住宅IP: ${list}\n${out}`;
  }
  return out;
}

/** 看起来像订阅链接列表（vless:// / vmess:// / trojan:// …） */
export function looksLikeLinkList(text) {
  return /^\s*(vless|vmess|trojan|ss|ssr|hysteria2?|tuic):\/\//im.test(text);
}

/**
 * 改写单条订阅链接里的 path 查询参数。
 * 例如 vless://uuid@1.2.3.4:8443?path=%2F%3Fed%3D2560
 */
function rewriteUriPath(line, host) {
  const q = line.indexOf('?');
  if (q < 0) return line;
  const hash = line.indexOf('#', q);
  const head = line.slice(0, q + 1);
  const query = hash >= 0 ? line.slice(q + 1, hash) : line.slice(q + 1);
  const tail = hash >= 0 ? line.slice(hash) : '';

  let touched = false;
  const parts = query.split('&').map((kv) => {
    const eq = kv.indexOf('=');
    if (eq < 0) return kv;
    if (kv.slice(0, eq).toLowerCase() !== 'path') return kv;
    touched = true;
    let decoded = kv.slice(eq + 1);
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      /* 编码异常时按原样处理 */
    }
    // 只转义会破坏查询串的字符，保持 path 可读
    const encoded = rewritePath(decoded, host)
      .replace(/%/g, '%25')
      .replace(/#/g, '%23')
      .replace(/&/g, '%26')
      .replace(/\+/g, '%2B')
      .replace(/\s/g, '%20');
    return `path=${encoded}`;
  });
  if (!touched) return line;
  return head + parts.join('&') + tail;
}

/**
 * 把住宅 IP 注入 base64/明文订阅链接列表（vless:// 等）。
 * 只改 path 里的 proxyip，其余字符保持不变；空行与注释原样保留。
 */
export function injectLinkList(list, hosts, comment = true) {
  if (!hosts || hosts.length === 0) return list;
  const primary = hosts[0];
  const lines = list.split(/\r?\n/).map((line) =>
    /^\s*(vless|vmess|trojan|ss|ssr|hysteria2?|tuic):\/\//i.test(line)
      ? rewriteUriPath(line, primary)
      : line,
  );
  if (comment) {
    const stamp = cstStamp();
    lines.unshift(`# [proxyip-worker] ${stamp} (UTC+8) 候选住宅IP: ${hosts.slice(0, 10).join(', ')}`);
  }
  return lines.join('\n');
}

/** 从 Clash 配置里提取所有 proxyip 值，便于对比 */
export function extractProxyIPs(yaml) {
  const set = new Set();
  const re = /\/proxyip=([^?\s"'&]+)/g;
  let m;
  while ((m = re.exec(yaml))) set.add(m[1]);
  return [...set];
}

/** 提取所有 path 值，用于校验注入是否完整 */
export function extractPaths(yaml) {
  const list = [];
  const re = /\bpath:\s*["']([^"']*)["']/g;
  let m;
  while ((m = re.exec(yaml))) list.push(m[1]);
  return list;
}
