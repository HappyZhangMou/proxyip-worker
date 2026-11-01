/**
 * 本地测试：只测纯逻辑（打分 / 注入 / 提取），不发起网络请求
 * 运行： node test/local-test.js
 */

import {
  scoreIP,
  injectProxyIP,
  extractProxyIPs,
} from '../src/lib.js';

let pass = 0;
let fail = 0;

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? '  → ' + detail : ''}`);
  }
}

// ---------------------------------------------------------------- 打分

console.log('\n[1] 住宅判定打分');

{
  const { score, reasons } = scoreIP(
    'static-71-168-153-36.cmdnnj.fios.verizon.net',
    { as: 'AS701 Verizon Business', hosting: false, proxy: false, mobile: false },
  );
  check('Verizon FiOS 得分 80', score === 80, `score=${score} ${reasons}`);
}

{
  const { score } = scoreIP('', { as: 'AS14061 DigitalOcean, LLC', hosting: true, proxy: false });
  check('DigitalOcean 负分', score < 0, `score=${score}`);
}

{
  const { score } = scoreIP('vps-01.example.net', { hosting: false, proxy: false });
  check('PTR 含 vps 负分', score < 0, `score=${score}`);
}

{
  const { score } = scoreIP('static-1-2-3-4.dynamic.isp.net', { as: 'AS12345 ISP', hosting: false, proxy: false });
  // 住宅关键词只加一次分（containsAny 命中即止），且 PTR 非空时不加「无 PTR」的 5 分
  check('dynamic 得分 20', score === 20, `score=${score}`);
}

{
  const { score } = scoreIP('', { as: 'AS1 X', hosting: false, proxy: false, mobile: true });
  // 移动 +15，无 PTR 但未被标记 +5
  check('移动网络得分 20', score === 20, `score=${score}`);
}

{
  const { score } = scoreIP('', { as: 'AS1 X', hosting: false, proxy: true });
  check('标记 proxy 扣分', score === -60, `score=${score}`);
}

{
  const { score } = scoreIP('', null);
  check('完全无信息 负分', score < 0, `score=${score}`);
}

// ---------------------------------------------------------------- 注入

console.log('\n[2] 订阅注入');

const sampleYaml = [
  'proxies:',
  '  - {name: "HK", server: 1.2.3.4, port: 8443, type: vless,',
  '     path: "/proxyip=ProxyIP.SG.CMLiussss.net?ed=2560", servername: gzt.us.ci}',
  '  - {name: "JP", server: 5.6.7.8, port: 8443, type: vless,',
  '     path: "/proxyip=ProxyIP.KR.CMLiussss.net?ed=2560", servername: gzt.us.ci}',
  'proxy-groups:',
  '  - name: TEST',
  'rules:',
  '  - MATCH,TEST',
].join('\n');

const hosts = ['71.168.153.36:443'];
const injected = injectProxyIP(sampleYaml, hosts);

check('注入了单个住宅 IP', injected.includes('proxyip=71.168.153.36:443'), '');
check('旧 SG 池已替换', !injected.includes('ProxyIP.SG.CMLiussss.net'));
check('旧 KR 池已替换', !injected.includes('ProxyIP.KR.CMLiussss.net'));
check('保留了 ed=2560 参数', (injected.match(/ed=2560/g) || []).length === 2);
check('保留了 proxies 结构', injected.includes('proxies:') && injected.includes('proxy-groups:'));
check('注释记录了时间戳', /^# \[proxyip-worker\]/.test(injected));
check('节点数量未变', (injected.match(/type: vless/g) || []).length === 2);

// 校验替换后每个节点都有 proxyip
{
  const re = /path: "([^"]+)"/g;
  let m;
  let count = 0;
  let allGood = true;
  while ((m = re.exec(injected))) {
    count++;
    if (!m[1].includes('proxyip=71.168.153.36:443')) allGood = false;
  }
  check('所有节点 path 均指向住宅 IP', count === 2 && allGood, `count=${count}`);
}

// 空列表不应破坏原文
{
  const untouched = injectProxyIP(sampleYaml, []);
  check('空列表原样返回', untouched === sampleYaml);
}

// 多候选时用第一个
{
  const multi = injectProxyIP(sampleYaml, ['1.1.1.1:443', '2.2.2.2:443']);
  check('多候选取第一个', multi.includes('proxyip=1.1.1.1:443') && !multi.includes('proxyip=2.2.2.2'));
  check('注释列出多个候选', multi.includes('1.1.1.1:443, 2.2.2.2:443'));
}

// ---- 关键场景：上游没有 proxyip（后台开了「自动获取」）----
console.log('\n[2b] 上游无 proxyip 时插入');

const noProxyYaml = [
  'proxies:',
  '  - {name: "HK", server: 1.2.3.4, port: 8443, type: vless,',
  '     xhttp-opts: {path: "/?ed=2560", host: gzt.us.ci}}',
  '  - name: "JP"',
  '    server: 5.6.7.8',
  '    type: vless',
  '    xhttp-opts:',
  '      path: "/?ed=2560"',
  'rules:',
  '  - MATCH,DIRECT',
].join('\n');

const noProxyOut = injectProxyIP(noProxyYaml, ['71.168.153.36:443']);
const noProxyPaths = noProxyOut.match(/path: "([^"]+)"/g) || [];
check('flow map 插入 proxyip', noProxyOut.includes('path: "/proxyip=71.168.153.36:443?ed=2560"'), '');
check('ed=2560 保留', noProxyOut.includes('?ed=2560'));
check('两条 path 都注入', extractProxyIPs(noProxyOut).length === 1 && (noProxyOut.match(/proxyip=71\.168\.153\.36:443/g) || []).length === 2, `出现 ${(noProxyOut.match(/proxyip=/g)||[]).length} 次`);
check('无重复 proxyip=', !noProxyOut.includes('proxyip=proxyip='), '');
check('YAML 结构未被破坏', noProxyOut.includes('proxies:') && noProxyOut.includes('rules:'));

// ---- 有 PATH 前缀的形态 ----
console.log('\n[2c] 带 PATH 前缀');

{
  const p = '/abc-123/proxyip=1.1.1.1?ed=2560';
  const got = injectProxyIP(`proxies:\n  - {path: "${p}"}\n`, ['9.9.9.9:443']);
  check('保留 PATH 前缀', got.includes('/abc-123/proxyip=9.9.9.9:443'), got.split('\n')[1]);
  check('ed 保留', got.includes('?ed=2560'));
}

{
  const p = '/abc-123/?ed=2560';
  const got = injectProxyIP(`proxies:\n  - {path: "${p}"}\n`, ['9.9.9.9:443']);
  check('PATH 前缀 + 无 proxyip 正确插入', got.includes('/abc-123/proxyip=9.9.9.9:443?ed=2560'), got.split('\n')[1]);
}

{
  const p = '/proxyip=1.1.1.1';
  const got = injectProxyIP(`proxies:\n  - {path: "${p}"}\n`, ['9.9.9.9:443']);
  check('无参数时替换正确', got.includes('"/proxyip=9.9.9.9:443"'), got.split('\n')[1]);
}

{
  const got = injectProxyIP(`proxies:\n  - {path: "/"}\n`, ['9.9.9.9:443']);
  check('根路径 path 正确追加', got.includes('"/proxyip=9.9.9.9:443"'), got.split('\n')[1]);
}

// ---- 无引号写法 ----
{
  const got = injectProxyIP('proxies:\n  - path: /?ed=2560\n', ['9.9.9.9:443']);
  check('无引号 path 也能注入', got.includes('path: /proxyip=9.9.9.9:443?ed=2560'), got.split('\n')[1]);
}

// ---------------------------------------------------------------- 提取

console.log('\n[3] proxyip 提取');

{
  const found = extractProxyIPs(sampleYaml);
  check('提取到 2 个不同 proxyip', found.length === 2, found.join(', '));
  check('包含 SG 池', found.some((x) => x.includes('SG')));
  check('包含 KR 池', found.some((x) => x.includes('KR')));
}

{
  const found = extractProxyIPs(injected);
  check('注入后只剩 1 个 proxyip', found.length === 1, found.join(', '));
  check('注入后是住宅 IP', found[0] === '71.168.153.36:443', found[0]);
}

// ---------------------------------------------------------------- 路径直通

console.log('\n[4] 路径直通（/<订阅key>）');

const RESERVED = new Set(['', 'sub', 'json', 'best', 'refresh', 'health', 'favicon.ico']);
function looksLikeKey(pathname) {
  const seg = pathname.replace(/^\/+|\/+$/g, '');
  if (seg.includes('/')) return false;
  if (!/^[A-Za-z0-9._-]{2,64}$/.test(seg)) return false;
  return !RESERVED.has(seg.toLowerCase());
}

check('/HappyZhang 识别为 key', looksLikeKey('/HappyZhang') === true);
check('/my-sub_2024 识别为 key', looksLikeKey('/my-sub_2024') === true);
check('/aB3.x-y 识别为 key', looksLikeKey('/aB3.x-y') === true);
check('/sub 是保留路径', looksLikeKey('/sub') === false);
check('/json 是保留路径', looksLikeKey('/json') === false);
check('/refresh 是保留路径', looksLikeKey('/refresh') === false);
check('/best 是保留路径', looksLikeKey('/best') === false);
check('/favicon.ico 是保留路径', looksLikeKey('/favicon.ico') === false);
check('/a/b 多段不算 key', looksLikeKey('/a/b') === false);
check('/ab!@# 非法字符不算 key', looksLikeKey('/ab!@#') === false);
check('/(空) 不算 key', looksLikeKey('/') === false);
check('/x 太短不算 key', looksLikeKey('/x') === false);
check('65 位超长不算 key', looksLikeKey('/' + 'a'.repeat(65)) === false);

// 上游 URL 拼接
{
  const upstream = 'gzt.us.ci';
  const build = (key, qs) => `https://${upstream}/${key}${qs}`;
  check('key 拼接正确', build('HappyZhang', '') === 'https://gzt.us.ci/HappyZhang');
  check('带参数拼接正确', build('HappyZhang', '?flag=clash') === 'https://gzt.us.ci/HappyZhang?flag=clash');
}

// ---------------------------------------------------------------- 汇总

console.log(`\n${'='.repeat(46)}`);
console.log(`通过 ${pass}   失败 ${fail}`);
console.log('='.repeat(46));
process.exit(fail > 0 ? 1 : 0);
