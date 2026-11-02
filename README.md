# 住宅 ProxyIP 订阅重写 Worker

自动从公共 ProxyIP 池里挑出**真正的住宅 IP**，并在你更新订阅时注入进去。
填一次订阅地址，以后不用再手动改。

## 快速开始（3 步）

| 角色 | 域名 |
|---|---|
| 本 Worker（订阅重写） | `<你的Worker域名>` |
| 上游订阅面板 | `<订阅面板域名>`（节点来源，照旧可用） |

**1. Cloudflare 控制台 → Worker → Settings → Variables**
`UPSTREAM = <订阅面板域名>`（**不要填 `<你的Worker域名>`，那是本 Worker 自己，会自环返回 500**）。

**2. 重新部署**（push `main` 或控制台 Redeploy），然后预热：

```bash
curl "https://<你的Worker域名>/refresh?token=你的TOKEN"
```

**3. Clash / Bettbox 订阅地址改成：**

```
https://<你的Worker域名>/<订阅key>?clash=1
```

key 不用变。若线上还是旧版（`/<订阅key>` 返回 502），先用这条等价地址：

```
https://<你的Worker域名>/sub?url=https%3A%2F%2F<订阅面板域名>%2F<订阅key>%3Fclash%3D1
```

详见下方「域名分工」与「在 Clash / Bettbox 里使用」。

## 为什么是这个架构

我先核查了 CM 版 edgetunnel 的源码，`PROXYIP` 变量的处理只有一个函数：

```js
async function 整理成数组(内容) {
  var 替换后的内容 = 内容.replace(/[\t"'\r\n]+/g, ',').replace(/,+/g, ',');
  return 替换后的内容.split(',');
}
```

**它只做逗号切分，不会 fetch URL。** 所以往 `PROXYIP` 里填 Worker 域名是无效的——
它只会被当成一个叫 `xxx.workers.dev` 的普通 proxyip 字符串去连接，必然失败。

能实现「填一次」的正确做法是**订阅重写**：让 Clash 的订阅地址指向本 Worker，
Worker 每次被请求时读取已缓存的住宅 IP，实时注入进 YAML 再返回。
你在 `<订阅面板域名>` 里什么都不用填，只在 Clash 里改一次订阅地址（改成 `<你的Worker域名>`）。

## 关于免费版限制（上一版超限的原因）

| 限制项 | 免费版额度 | 上一版问题 |
|---|---|---|
| 子请求数 | **50 / 请求** | 141 个 IP 要 141 次 PTR 查询，直接爆 |
| 并发出站连接 | **6** | 无节制 `Promise.all`，超限报错 |
| CPU 时间 | **10 ms** | 大对象遍历容易触发 1102 |

本版对策：

| 措施 | 说明 |
|---|---|
| 增量扫描 | `BATCH_PER_RUN = 24`，每轮 cron 只处理一小批，子请求 ≤ 26 |
| 并发上限 | `CONCURRENCY = 4`，留 2 个余量 |
| 分开调度 | cron 每 5 分钟推进一批，池子大也能在 25 分钟内扫完（KV 写入约 288 次/天，仍远低于免费版 1000/天） |
| 结果落 KV | `/sub` 只读 KV，几乎零 CPU、零子请求 |

## 部署方式

**推荐：Git 集成（Workers Builds）** —— 推一次代码，Cloudflare 自动构建部署。

| 方式 | 入口 | 适用场景 |
|---|---|---|
| **A. Git 集成** ⭐ | `src/index.js` | 长期维护，改完 push 即部署 |
| **B. Dashboard 粘贴** | `dist/_worker.js`（单文件） | 不想装 Node，复制粘贴 |
| **C. 本地 wrangler** | `src/index.js` | 本地调试 |

### 方式 A：Git 集成（推荐）

**1. 把本目录推到 GitHub**

```bash
cd proxyip-worker
git init -b main
git add .
git commit -m "feat: residential proxyip subscription rewriter"
git remote add origin git@github.com:<你的用户名>/proxyip-worker.git
git push -u origin main
```

**2. Cloudflare 控制台连接仓库**

1. Workers & Pages → **Create** → **Connect to Git**
2. 授权 GitHub，选刚推的仓库
3. 分支选 `main`
4. 构建设置保持默认：

   | 项 | 值 |
   |---|---|
   | Build command | *（留空）* |
   | Deploy command | `npx wrangler deploy` |

   本项目是纯 JS 没有编译步骤，不需要 build command。
   Cloudflare 会用 `package.json` 里声明的 wrangler 版本执行 deploy。

5. 点 **Deploy**

**3. 绑定 KV 与变量**

部署完成后进 **Settings**：

- **Variables and Secrets**：

  | 类型 | 名称 | 值 |
  |---|---|---|
  | **Secret** | `TOKEN` | 自己编的随机串 |
  | Text | `UPSTREAM` | `<订阅面板域名>`（订阅面板，不能填 Worker 自己的域名） |
  | Text | `PROXYIP_DOMAINS` | 见 `wrangler.toml` |
  | Text | `MIN_SCORE` | `20` |
  | Text | `OUTPUT_PORT` | `443` |

- **Bindings → KV Namespace**：绑定 `CACHE` → 选你的 KV

  > `wrangler.toml` 里已经写了 KV ID，Git 部署时也会生效。
  > 如果用的是别人的仓库或用的是自己的 KV，改一下 `wrangler.toml` 里的 `id` 再 push。

- **Triggers → Cron**：`*/5 * * * *`
  （`wrangler.toml` 里已配好，通常会自动生效，可在控制台核对）

- **关闭预览 URL**（每次 push 都会生成预览地址）：

  Settings → **Build** → **Branch control** → 取消勾选 **Enable Preview Builds**

  > 该开关只在控制台，`wrangler.toml` 没有对应字段。
  > 本项目只从 `main` 部署，关掉后非生产分支的 push 不会再生成预览构建/预览 URL。

**4. 预热**

访问一次 `https://<你的Worker域名>/refresh?token=你的TOKEN`，让首批住宅 IP 进入 KV。

之后每次 push 到 `main` 都会自动重新部署。

> ⚠️ 不要把 `TOKEN` 写进 `wrangler.toml` 再提交。用 Secret。

### 方式 B：Dashboard 粘贴

先构建单文件版：

```bash
node scripts/build-single-file.mjs
```

然后 Workers & Pages → Create → Hello World → Deploy → **Edit code**，
把 `dist/_worker.js` 全文粘进去，Deploy。
变量、KV、Cron 的配置同方式 A 的第 3 步。

> 单文件版由 `src/` 自动生成，**不要手动编辑**，改动请改 `src/` 后重新 build。

### 方式 C：本地 wrangler

```bash
npm install
npx wrangler login
npx wrangler kv namespace create CACHE   # 把 id 填进 wrangler.toml
npx wrangler secret put TOKEN
npx wrangler dev      # 本地调试
npx wrangler deploy   # 发布
```

---

### 仓库结构

```
proxyip-worker/
├── src/
│   ├── index.js          # Worker 入口：路由 + 增量扫描
│   └── lib.js            # 纯逻辑：打分 / 注入（可单测）
├── scripts/
│   └── build-single-file.mjs   # 生成 dist/_worker.js
├── test/
│   └── local-test.js     # 61 项测试
├── dist/                 # 构建产物（gitignore，Dashboard 用）
├── wrangler.toml
├── package.json
└── README.md
```

`dist/` 已加入 `.gitignore`。需要 Dashboard 版时本地跑 `npm run build` 即可。

---

### 在 Clash / Bettbox 里使用

本 Worker 部署在 `<你的Worker域名>`，节点订阅来自上游面板 `<订阅面板域名>`。

**方式一：路径直通（推荐）**

把 Worker 域名当订阅域名用，路径原样透传给上游：

```
https://<你的Worker域名>/<订阅key>?clash=1
```

Worker 收到后去拉 `https://<订阅面板域名>/<订阅key>?clash=1`，注入住宅 IP 再返回。
**订阅 key `<订阅key>` 不用改，只把域名换成 `<你的Worker域名>`。**

> `?clash=1` 用来让面板返回 Clash YAML。不带这个参数时面板返回 base64 的
> `vless://` 链接列表（v2rayN 用），本 Worker 两种格式都能注入。

**方式二：显式 /sub（当前线上最稳）**

```
https://<你的Worker域名>/sub?url=https%3A%2F%2F<订阅面板域名>%2F<订阅key>%3Fclash%3D1
```

适合临时换上游、或上游 key 不在根路径的情况。没配 `TOKEN` 时不需要带 `token` 参数。

> ⚠️ 如果线上还没更新到最新代码（旧版 `/` 与 `/<订阅key>` 会 502），
> **先用方式二把订阅地址填进 Clash**，实测可正常拿到注入后的 33 个节点。
> 等重新部署完成后，再换回方式一更短。

---

**两种方式效果相同**，都会把节点 `path` 里的 proxyip 换成住宅 IP。之后 Clash 每次更新订阅都会自动注入最新的住宅 IP，**你不需要再碰 `<订阅面板域名>` 的 PROXYIP 输入框**。

## 线上版本差异（重要）

截至 2026-11-02 实测，`<你的Worker域名>` 上跑的还是**旧版代码**：

| 能力 | 旧版（线上） | 新版（本仓库） |
|---|---|---|
| `/<key>` 路径直通 | ❌ 502（UPSTREAM 自环） | ✅ 正常 |
| `/sub?url=...?clash=1`（Clash YAML） | ✅ 33/33 注入 | ✅ 33/33 注入 |
| `/sub?url=...`（base64 vless 列表） | ❌ 解码后按 YAML 处理，0 注入 | ✅ 33/33 注入 |
| `UPSTREAM` 填成自身 | ❌ 哑 502 | ✅ 500 + 明确提示 |

重新部署后上表右列全部可用。**在那之前，Clash 订阅请用 `?clash=1` 的 `/sub` 地址**，
不要用 base64 模式，也不要依赖 `/<key>` 直通。

## 接口

| 路径 | 鉴权 | 说明 |
|---|---|---|
| `/<订阅key>` | ❌ | **路径直通**：拉 `https://<UPSTREAM>/<key>` 并注入（例 `/<订阅key>`） |
| `/sub?url=&token=` | ✅ | 显式订阅重写，`url` 为完整上游地址 |
| `/` | ❌ | 纯文本住宅 IP 列表 + 扫描进度 |
| `/best` | ❌ | 单个 `IP:443` |
| `/json` | ❌ | 完整 JSON（含分数、PTR、上游域名） |
| `/refresh?token=` | ✅ | 手动推进一轮扫描 |

> 路径直通会避开这些保留名：`sub`、`json`、`best`、`refresh`、`health`、`favicon.ico`。
> 其他单段路径（2-64 位 `A-Za-z0-9._-`）都会被识别为订阅 key。

## 注入逻辑

上游的 `path` 有三种形态，注入器都能正确处理：

| 上游 path | 注入结果 |
|---|---|
| `/proxyip=1.1.1.1?ed=2560` | `/proxyip=203.0.113.7:443?ed=2560` |
| `/<uuid>/proxyip=1.1.1.1?ed=2560` | `/<uuid>/proxyip=203.0.113.7:443?ed=2560` |
| `/?ed=2560`（后台开了「自动获取」） | `/proxyip=203.0.113.7:443?ed=2560` |

第三种是**新增**而非替换，早期版本会漏掉这种情况（导致完全没注入），已修复并加了 6 项回归测试。

同时支持行内 flow map 与块格式、带引号与不带引号四种写法。

## 判定逻辑

综合打分，`MIN_SCORE` 默认 20：

| 信号 | 分值 |
|---|---|
| PTR 命中住宅 ISP 品牌（fios / comcast / hinet …） | **+60** |
| PTR 含住宅关键词（dynamic / dsl / pppoe / ftth …） | +20 |
| PTR 含机房关键词（vps / cloud / colo …） | **−80** |
| ip-api 标记 `hosting` | −60 |
| ip-api 标记 `proxy` | −60 |
| 移动网络 | +15 |
| 已知机房 ASN（39 个） | −50 |
| 无 PTR 但未被标记 | +5 |

## 测试

```bash
npm test          # 等价于 node test/local-test.js
```

当前 **61/61 通过**，覆盖：

| 分组 | 数量 | 内容 |
|---|---|---|
| 打分规则 | 7 | FiOS 80 分、DigitalOcean 负分、vps 负分、dynamic 20 分、移动 20 分、proxy 扣分、无信息负分 |
| 订阅注入 | 11 | 单 IP 注入、多池同时替换、`ed=2560` 保留、节点数不变、空列表原样返回、多候选取第一个、注释生成 |
| 无 proxyip 插入 | 6 | flow map 插入、双 path 注入、无重复、结构完整 |
| 带 PATH 前缀 | 6 | 保留前缀、带/不带参数、根路径追加、无引号写法 |
| proxyip 提取 | 5 | 改前 2 个池、改后 1 个住宅 IP |
| 链接列表注入 | 12 | base64/明文 vless 的 path 改写、host/sni 不变、注释与空行保留 |
| 路径直通 | 15 | key 识别、13 种保留名/非法格式边界、URL 拼接 |

构建单文件版（Dashboard 用）：

```bash
npm run build     # 生成 dist/_worker.js
```

### 本地实测（wrangler dev + 真实订阅）

用你的订阅 `https://<订阅面板域名>/<订阅key>?clash=1` 跑通了全部接口：

**`/refresh`**（触发扫描）
```json
{"ok":true,"scanned":24,"poolSize":69,"cursor":24,
 "residential":[{"ip":"203.0.113.7","ptr":"static-203-0-113-7.cmdnnj.fios.verizon.net",
 "isp":"Verizon Business","as":"AS701 Verizon Business","country":"US","score":80}]}
HTTP 200   8.6s
```

**`/<订阅key>`**（路径直通，核心功能）
```
HTTP 200   191907 bytes
Content-Type: text/yaml; charset=utf-8
profile-update-interval: 6
profile-web-page-url: http://127.0.0.1:8787/
```

YAML 解析校验：
```
节点数       : 33
已注入节点   : 33 / 33        ← 全部成功
样例 path    : /proxyip=203.0.113.7:443?ed=2560
ed=2560 保留 : True
YAML 有效    : True
```

**其他接口**
| 测试 | 结果 |
|---|---|
| `/` | 显示「上游: <订阅面板域名>，已扫描 48 / 池内 116」 |
| `/json` | 含 `"upstream": "<订阅面板域名>"` |
| `/<订阅key>?flag=clash` | 200，查询参数正确透传 |
| `/best` | `203.0.113.7:443` |
| `/NoSuchKey123` | 502（上游 404）✅ |
| `/sub` 错误 token | 401 ✅ |
| `/sub` 无 token | 401 ✅ |
| `/sub` 缺 url | 400 ✅ |
| base64 上游 | 自动解码并注入 ✅ |

## 域名分工（2026-11 更新）

| 角色 | 域名 | 说明 |
|---|---|---|
| 本 Worker（订阅重写） | `<你的Worker域名>` | 部署地址，Clash 里填这个 |
| 上游订阅面板 | `<订阅面板域名>` | 真正的节点订阅来源，仍在正常服务 |

`UPSTREAM` 必须填**订阅面板**域名，不能填 Worker 自己的域名 `<你的Worker域名>`，
否则 Worker 会去请求自己形成自环（新代码已加检测，会直接返回 500 并提示）。

```toml
[vars]
UPSTREAM = "<订阅面板域名>"     # ✅
# UPSTREAM = "<你的Worker域名>" # ❌ 自环
```

> 控制台里手动配过 `UPSTREAM` 变量会覆盖 `wrangler.toml`，改完记得重新部署。
## 注意事项

### Worker 判断不了「能不能真当中继」

本方案只能判断 IP 的**归属**（PTR + ASN）。某个 IP 是否真能作为 Cloudflare
Worker 的 proxyip 中继，取决于 CF 边缘到它的连通性，本地无法测。

所以注入了住宅 IP 后，仍建议实测一次：

```bash
curl -x http://127.0.0.1:7890 -I https://gemini.google.com
```

不跳 `/sorry` 才算成功。如果不通，可以在 `/json` 里看下一个候选，手动换。

### 住宅 IP 是稀缺资源

`proxyip.us.fxxk.dedyn.io` 的 50 个 IP 里通常只有 1 个是真住宅。
本 Worker 的价值是自动定位它，不是保证它长期存在。

需要长期稳定，建议自购静态住宅 IP（Webshare / IPRoyal 的 ISP 套餐，约 $2-5/IP/月），
独占不会被池主剔除。

### 上游订阅格式

`/sub` 同时支持：

- 明文 Clash YAML
- base64 编码的节点列表（自动解码）

如果上游返回的是 v2ray 订阅格式（`vmess://` / `vless://` 列表），本 Worker 不做转换，
需要先用 Subconverter 转成 Clash 格式，再把 Subconverter 的输出喂给本 Worker。
