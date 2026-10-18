# PoofSpace 部署说明

一个 Node.js 进程 + 一个嵌入式 SQLite 文件，没有独立的数据库服务、Redis 或对象存储。
WebSocket 与网页同源（同一个 `HOST:PORT`），因此不需要额外的端口或 CORS 配置。

## 1. 目标服务器的先决条件

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | **运行** >= 20.9；**跑测试套件** >= 20.19 | 两个下限不是一回事：产物在 20.9.0 上能起（CI 那一臂真跑 typecheck + build + 解包启动），但 `vite@7` 自己声明 `^20.19.0 \|\| >=22.12.0`，在 20.9.0 上加载 vitest 配置会 `ERR_REQUIRE_ESM` ⇒ 低版本那一臂只验运行、不跑 `npm test`。口径由 `tests/governance/node-version-claims-agree.test.ts` 对撞，**不随产物打包** |
| PM2 | 任意稳定版 | **不随产物打包** |
| 磁盘 | `DATA_DIR` 所在目录必须可写且持久 | 房间密文与附件分片都落在这里 |
| 操作系统/架构 | 与构建机一致 | `better-sqlite3` 含原生 `.node` 二进制，产物是平台相关的 |

产物里已经包含全部生产依赖，目标服务器**不需要** `npm install`、`npm ci` 或 `npm run build`。
图片查看器用的 `photoswipe@5.4.4`（MIT、`dependencies: {}` 零传递依赖）是纯前端 ESM，随客户端包一起
打进产物，运行时不从网络取；门禁 B2 的依赖名单**从交付包自己的 `package.json` 派生**，
所以"声明了却没进包"这件事本身就是红灯，不依赖有人记得手抄名单。

## 2. 取包与解压

在构建机上：

```bash
npm ci
npm run release     # = node scripts/build-release.mjs
```

产出 `release/poofspace/`（可直接拷贝的目录树）与 `release/poofspace-deploy.tar.gz`。
`npm run release` **每次都重跑** `tsc`（自定义服务端）与 `next build`，再把 `dist/`、`.next/` 原样拷进产物；
只有显式 `--no-build` 才复用已有输出，且复用前会比对源戳，输出比源码旧就直接报错拒绝发布。
`npm run release` 在打包之后会**实际启动**两份产物做验证：一份是 `release/poofspace/` 的独立副本，
一份是 tar 解压出来的树；两者都要通过健康检查、建/入/销毁房间与重启恢复检查，
否则脚本报错并拒绝发布。结果写在 `release/build-info.json`
（`stagedCopyVerified` / `extractedTarballVerified` / `platform` / `arch` / `node` / `abi` / `packages` /
`sourceNewestMs`）。`npm run gates` 的 B2/B3/B5 会拒收"没有源戳"或"打包之后源码又动过"的产物 ——
所以**改了 `src/` 就必须重新 `npm run release`**，否则那三条不会认这个包。

随包发出去的文档由 `SHIPPED_DOCS` 一处决定：`LICENSE`、中英 README、`CHANGELOG.md`、
`docs/DEPLOYMENT.md`、`docs/SECURITY.md`、`docs/TEST-REPORT.md`、`docs/ARCHITECTURE.md`、`docs/DEBT.md`。
审计还会检查这组文档**在自己的文字里指向的 docs 文件也在包里** —— 说明书让运维去看欠账台账，
包里却没有那本台账，就算审计失败。

在目标服务器上：

```bash
mkdir -p /opt/poofspace && cd /opt/poofspace
tar -xzf poofspace-deploy.tar.gz     # 得到 poofspace/ 目录
```

## 3. 数据目录（不要放在 Web 静态目录里）

运行时数据永远在产物目录**之外**，由 `DATA_DIR` 指定；默认 `~/.poofspace/data`（`ecosystem.config.cjs` 决定）。

```
$DATA_DIR/
├── poofspace.sqlite(+ -wal / -shm)   # 房间状态、消息密文、附件索引、会话令牌
├── rooms/<room-id>/                  # 该房间的加密分片，销毁时整目录清空
└── admin-control.json                # 本地管理通道的端口 + 一次性令牌（0600，进程退出时删除）
```

`admin-control.json` 就是运维能力本身：谁能读它，谁才能执行 §8.1 那两条命令。
它不在 `rooms/` 下、也不是静态路径；服务正常退出时会把它删掉，异常退出留下的陈旧文件会被下一次启动覆盖。

关键性质：发布升级替换的是 `/opt/poofspace/poofspace` 这棵树，**不会覆盖或删除 `DATA_DIR`**，
所以重启发版不会丢房间；产物树里也不含 `data/`，构建脚本发现它会直接失败。
`data/` 同时不是可访问的静态路径，产物自检会去请求 `/data/poofspace.sqlite` 等三个路径确认拿不到数据库文件。

备份/迁移只需要备份 `DATA_DIR`（建议先 `pm2 stop poofspace` 或使用 SQLite 的 backup API，避免拷到 WAL 中间态）。
注意：备份里是密文，服务器侧没有密钥，恢复后仍需要原来的邀请链接才能解密。

## 4. 启动、停止、看日志（PM2，fork 单实例）

从产物目录内执行：

```bash
cd /opt/poofspace/poofspace
pm2 start ecosystem.config.cjs --env production
pm2 save                    # 宿主机重启后自动拉起
pm2 status
pm2 logs poofspace
pm2 restart poofspace
pm2 stop poofspace
pm2 delete poofspace
```

配置写死了 `instances: 1, exec_mode: 'fork'`：WebSocket 连接、房间内存状态和限流桶都在进程内，
SQLite 是单文件；cluster 会让成员分散到不同 worker、reload 时会把房间留在垂死的 worker 里。
要扩容请在负载均衡后面多机部署，不要加实例数。
`kill_signal: SIGINT` + `kill_timeout: 15000` 给进程一次优雅退出（收拢连接、WAL checkpoint）。

**并发规则（销毁 / 数据库维护 / PM2 重启同时发生时）**：

- 一个进程只有一个 Node 事件循环，所有 SQLite 写都是同步事务，因此"销毁"与"加入"不会交错：
  房间进入 `DESTROYING` 之后，任何加入、写入、上传、下载都走拒绝分支（`tests/lifecycle` 第 6 条把
  请求、刷新、重启三扇门都试过了）。
- 清理没证明完成，房间就一直留在 `DESTROYING` 里占一个 `MAX_ROOMS` 名额，清扫按 `DESTROY_RETRIES`
  间隔重试；这时**不要**手工删库来"腾位置"——那会绕过受控存储清理。
- `pm2 restart` 打断一个正在清理的进程是安全的：下次启动会先扫 `DESTROYING` 把没做完的清理做完，
  再处理恢复窗口已过期的房间；`rooms/` 里没有库引用的目录也在同一次扫描里被清掉。
- 管理命令（§8.1）与重启之间：先 `pm2 stop poofspace` 再用 `--offline`；服务在跑的时候 `--offline`
  会被自己拒绝（它不能删一个仍被打开的数据库文件）。

## 5. 五种部署形态

同一份产物靠环境变量区分，源码里没有硬编码域名/IP/端口/协议；客户端按页面协议自动选 `ws://` 或 `wss://`。

### 5.1 局域网 IP + HTTP 端口

```bash
HOST=0.0.0.0 PORT=3000 DATA_DIR=/srv/poofspace/data pm2 start ecosystem.config.cjs --env production
```

访问 `http://192.168.1.100:3000`。此时页面不是安全上下文，`crypto.subtle` 不存在：
客户端自动改用打包在产物里的 `@noble/ciphers` AES-256-GCM，聊天室照常可用（真实浏览器门禁已验证）。
但**传输链路本身是明文的**，锁形提示会如实说明这一点，不要把它当成 HTTPS 的等价物。

### 5.2 公网 IP + HTTP 端口

同 5.1，只是把端口做成公网可达。安全边界与 5.1 相同（应用层密文不暴露，链路易被观察/篡改），
公网暴露时建议至少配合 5.5 的 Nginx 上 TLS。

### 5.3 域名 + HTTPS（Node 自己终止 TLS）

```bash
HOST=0.0.0.0 PORT=3000 \
TLS_CERT_FILE=/etc/ssl/poofspace.crt TLS_KEY_FILE=/etc/ssl/poofspace.key \
PUBLIC_BASE_URL=https://poof.example.com \
pm2 start ecosystem.config.cjs --env production
```

### 5.4 IP + HTTPS

与 5.3 相同，只需证书里包含该 IP（`subjectAltName = IP:203.0.113.10`），
并把 `PUBLIC_BASE_URL` 写成 `https://203.0.113.10:3000`。

### 5.5 Nginx 反向代理终止 HTTPS → Node HTTP

仓库里的 `deploy/nginx.conf.example` 是可直接抄的配置：`/ws` 的 `Upgrade`/`Connection` 处理、
upstream keepalive、`proxy_read_timeout`、`client_max_body_size` 都按本项目的常量标注了理由。
Node 侧：

```bash
HOST=127.0.0.1 PORT=3000 TRUST_PROXY=true PUBLIC_BASE_URL=https://poof.example.com \
pm2 start ecosystem.config.cjs --env production
```

`TRUST_PROXY` 默认 `false`：不设置时服务器**完全不读**外部传入的 `X-Forwarded-*`，
也就不会被伪造的转发头骗到；只有确实部署在可信代理之后才打开它，
并让代理自己重写 `X-Forwarded-Proto`/`X-Forwarded-For`（见示例配置）。

## 6. 邀请链接的来源

生成邀请链接优先使用 `PUBLIC_BASE_URL`；未配置时使用浏览器自己的 `location.origin`（源码里没有写死的域名/端口）。
`PUBLIC_BASE_URL` 需要能被 `new URL()` 解析且协议是 `http:` 或 `https:`，客户端只取它的 `协议://主机:端口`
（路径前缀会被丢掉），解析不了就退回当前访问来源。末尾斜杠可有可无（服务端配置里会去掉）。
链接形如 `<base>/room/<room-id>#<secret>`，`#` 片段永远不发往服务器（浏览器不会把 fragment 放进请求）。
分享给别人请用房间里的**复制邀请链接 / 复制邀请码**按钮：进入房间后客户端已把 `#` 片段从地址栏抹掉（凭据改存在本设备凭据库里），
所以直接复制地址栏只会拿到不含秘密的 `/room/<room-id>`，对方进去会提示缺秘密 —— 这不是故障，是不让秘密长期停在地址栏与截图里。

## 7. 健康检查

```bash
node scripts/healthcheck.mjs --port 3000
node scripts/healthcheck.mjs --url https://poof.example.com/api/health
node scripts/healthcheck.mjs --host 192.168.1.100 --retries 3 --interval 2000
```

退出码 `0` 健康 / `1` 不可达或形状不对 / `2` 参数错误，可直接用作容器或监控探针。
输出只有计数器（proto、uptime、活跃房间数、在线数、ws 连接数），不含任何密钥、令牌、房间 ID 或请求头。

也可以用最简单的一条：

```bash
curl -fsS http://127.0.0.1:3000/api/health
```

## 8. 环境变量总表

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `3000` | 监听端口 |
| `DATA_DIR`（或 `POOFSPACE_DATA_DIR`） | PM2 下为 `~/.poofspace/data` | 运行数据根目录 |
| `DB_FILE` | `$DATA_DIR/poofspace.sqlite` | SQLite 主文件 |
| `ROOMS_DIR` | `$DATA_DIR/rooms` | 房间加密分片目录 |
| `PUBLIC_BASE_URL` | 空 | 邀请链接基址 |
| `TRUST_PROXY` | `false` | 是否采信代理的 `X-Forwarded-*` |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | 空 | 两者都给才由 Node 直接提供 HTTPS |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
| `MAX_PARTICIPANTS_PER_ROOM` | `100` | 每房间人数上限（服务端执行；客户端要求更大值也不会越过它），硬上限 `500` |
| `MAX_ROOMS` | `20` | 本节点同时承载的房间数；`ACTIVE`、`IDLE_GRACE` 与未完成清理的 `DESTROYING` 都占名额 |
| `ROOM_IDLE_TTL_SECONDS` | `300` | 最后一人离开后的**默认**恢复窗口（IDLE_GRACE），到期才进入销毁；允许 `30..86400`。这个 24 小时硬顶只管全局默认值，**不参与**每房延时的白名单 |
| `MAX_DELAYED_ROOMS` | `5` | 本节点同时持有"房主显式延长的恢复窗口"的房间数，校验区间 `0..MAX_ROOMS`；`0` = 整条延时功能关死（装填一律拒绝）。延长的房间**照常**占 `MAX_ROOMS` 名额，这个数只是再叠一层闸 |
| `MAX_CONNECTIONS_NODE` / `MAX_CONNECTIONS_PER_IP` | `4000` / `512` | WebSocket 握手前的连接闸门，超限以 HTTP 503 拒绝，不占事件循环槽位 |
| `TEMP_BYTES_MAX_NODE` | `20 GiB` | 全节点附件密文临时配额，与单房间配额一起把关 |
| `VACUUM_FREELIST_PAGES` | `4096` | 空闲页超过该数时执行 `VACUUM`，重写文件而不是把已删页面留在自由列表里 |
| `DESTROY_RETRY_MS` | `10000` | 未完成清理的重试间隔；房间在清理证明完成前保持 `DESTROYING` 并继续占用名额 |
| `ADMIN_CONTROL_FILE` | `$DATA_DIR/admin-control.json` | 本地管理通道（端口 + 令牌）登记文件，`0600` |
| `HEARTBEAT_SERVER_MS` / `HEARTBEAT_GRACE_MS` / `SLOT_GRACE_MS` | `15000` / `60000` / `45000` | 心跳与槽位保留；宽限必须是客户端 ping 周期（15 s）的数倍，否则移动端后台节流会把还活着的成员摘出花名册（`HEARTBEAT_GRACE_MS` 不要设到小于 3× 周期） |
| `CHUNK_BYTES_MAX` / `ATTACHMENT_BYTES_MAX` / `ROOM_ATTACHMENT_BYTES_MAX` | `4 MiB` / `256 MiB` / `2 GiB` | 分片、单附件、单房间容量 |
| `PENDING_UPLOAD_TTL_MS` | `1800000` | 未完成上传的回收时间 |
| `CSP_OVERRIDE` | 空 | 只在明确需要时覆盖响应头 CSP |

容量类变量在**启动时校验**：`MAX_ROOMS=0`、`MAX_ROOMS=many`、`ROOM_IDLE_TTL_SECONDS=5`、
`MAX_PARTICIPANTS_PER_ROOM=501` 都会让进程带着出错的变量名直接拒绝启动，而不是静默回落到默认值——
一个没有上限的节点和一个谁都进不去的房间同样糟糕。

## 8.1 运维管理命令（只在部署机上执行）

```bash
npm run admin:status                              # 只读聚合计数
npm run admin:rooms:disconnect-all -- --yes       # 停止接受 → 销毁全部房间 → 断开全部连接 → 恢复接受
npm run admin:data:purge-all -- --yes             # 全量清除 SQLite 与临时存储后再恢复服务
```

- 这两个命令**不是** HTTP 管理接口：公共服务端口上没有 `/admin`、`/rooms/disconnect-all` 之类的路由
  （门禁按 404 判），首页也没有任何管理入口，普通用户也没有能走到这里的权限。
- 管理通道是同一个进程另起的一个**只绑定 `127.0.0.1`** 的临时端口；端口与令牌写在
  `$DATA_DIR/admin-control.json`（`0600`）。能读到这个文件的人 = 已经拿到部署目录和操作系统权限的人；
  没有令牌一律 401，令牌用 `timingSafeEqual` 常数时间比对。
- 服务已停止时可以用 `--offline` 直接清理数据库文件（含 `-wal` / `-shm`）；
  但若探活发现服务仍在运行，命令**拒绝**删除仍被服务打开的数据库（PM2 在跑就先 `pm2 stop poofspace`），退出码 1。
- `data:purge-all` 必须先明确确认：交互输入 `PURGE`，非交互必须带 `--yes`；否则退出码 2 且不动任何数据。
  执行前会把爆炸半径打印出来，确认信息里不含房间 ID。
- 输出只有计数（房间数、行数、文件数、字节数），**不打印房间 ID、邀请秘密、会话令牌或任何正文**。
- 退出码可机器检查：`0` 完成，`1` 失败或仍处于维护态，`2` 用法/未确认，`3` 找不到服务。
- 任何清理失败都会如实报告并保持“停止接受新房间”，命令**不会**宣称数据已清空；
  故障排除后重跑同一条命令会把没做完的清理补完并恢复接受（`tests/admin` 第 7 条就是这个序列）。

## 9. 升级流程

```bash
pm2 stop poofspace
# 用新产物目录替换 /opt/poofspace/poofspace（保留 DATA_DIR 不动）
pm2 start ecosystem.config.cjs --env production
node scripts/healthcheck.mjs --port 3000 --retries 5
pm2 save
```

重新部署不会自动清空仍然有效的房间：旧库若还是 `schema_version=1` 或 `2`，启动时按**成链**迁移
（`v1→v2→v3`，每一跳只建自己那一版的表结构）原地升级，把当时已空房的房间认成 `IDLE_GRACE`，
不删任何一行。升级之后未装填的房间进入 `ROOM_IDLE_TTL_SECONDS`（默认 300 秒）恢复窗口
（进程重启意味着没有一条 WebSocket 还活着）；**房主装填过的房间带着它的 `idle_delay_ms` 继续等**，
到期时刻从不落库，所以一次重启不会把一间隔了 72 小时的房按 300 秒销毁（这条有专门的判据与刀）。
窗口内持邀请的人重新进入的是**同一间房**、读到的还是同一份历史；
窗口在停机期间已经过期的房间，会在启动扫描里被完成清理。
`DESTROYING` 会被继续清理完成；已销毁的房间在数据库里**不留记录**，因此旧链接、旧邀请码、旧 WebSocket
和本地缓存都无从复活（生命周期门禁 T3 已验证）。在线成员会经历一次断线，客户端按心跳/重连逻辑自动重连并补拉缺失消息。

## 10. 常见问题

- **端口被占 / 起不来**：`pm2 delete poofspace` 后重来；确认没有第二个进程在用同一个 `DATA_DIR`。
- **想换数据目录**：改 `DATA_DIR`，把旧目录的 `poofspace.sqlite*` 与 `rooms/` 一起搬过去，然后重启。
- **HTTPS 下锁形提示文案不对**：提示是按页面实际协议选的，先确认代理正确设置了 `X-Forwarded-Proto` 且开了 `TRUST_PROXY`。
- **日志里会不会有敏感内容**：日志只有事件与计数器，代码路径不记录明文消息、完整邀请链接、密钥或文件名；
  反向代理侧请照 `deploy/nginx.conf.example` 的说明，不要把 `$request_uri` 打进访问日志（`#` 片段不会到服务器，但查询串会）。
