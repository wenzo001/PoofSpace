# PoofSpace 架构说明

一句话：**一个 Node.js 进程 + 一个嵌入式 SQLite 文件**的端到端加密临时聊天室。服务端只搬运密文与最小元数据，任何房间内容的解密密钥都不进入服务端。

本文只描述代码里实际存在的东西。安全声明的边界写在 `docs/SECURITY.md`，实测数字写在 `docs/TEST-REPORT.md`。

## 1. 进程拓扑

```
浏览器  ──HTTP──►  同一个端口
   │                 ├── /api/*      自建路由（先于 Next）
   │                 ├── /ws         HTTP Upgrade → WsHub
   │                 └── 其余         Next.js App Router（页面/静态资源）
   └───WebSocket────► WsHub（join / 心跳 / 广播 / ack）
                     │
                     ├── RoomService  房间状态机、序列分配、去重、授权
                     ├── RoomStorage  附件分片（仅密文）落盘
                     └── Db           better-sqlite3（WAL, busy_timeout, 外键级联）
                     data/（poofspace.sqlite + rooms/<roomId>/<attachmentId>/<index>）
```

只有这一个进程。没有独立数据库服务、Redis、对象存储或第二个后台进程；WebSocket 跑在真实 Node 环境里，不是 serverless 路由，也不是轮询模拟。

- `src/server/server.ts`：`http`/`https` 服务器、每请求安全响应头、`/api` 与 `/ws` 的分流、Next 请求处理器的挂载、`resolveOrigin()`。
- 监听地址与端口来自 `HOST` / `PORT`（默认 `0.0.0.0:3000`）；域名、IP、端口、协议都不写在源码里。
- TLS 可选：给了 `TLS_CERT_FILE` + `TLS_KEY_FILE` 就用 `https` + `wss`，否则 `http` + `ws`。反代终止 TLS 时靠 `TRUST_PROXY` 决定要不要信 `X-Forwarded-*`（默认不信）。

## 2. 模块图

| 位置 | 职责 |
| --- | --- |
| `src/app/page.tsx`, `src/app/room/[roomId]/page.tsx` | 只有两个入口的首页、房间页。`#` 片段永远不进服务端 |
| `src/components/*` | `HomeView` `RoomView` `Modal` `NicknameDialog` `Avatar` `icons` |
| `src/lib/crypto/engine.ts` | AES-256-GCM 双引擎（有 `crypto.subtle` 用它，否则 `@noble/ciphers` 纯 JS）、HKDF、HMAC、能力探测 `detectCrypto()` |
| `src/lib/crypto/keys.ts` | 由邀请秘密派生房间密钥（见 §3） |
| `src/lib/crypto/envelope.ts` | 消息 / 分片的封包与拆包、nonce 结构、AAD |
| `src/lib/crypto/invite.ts` | 房间 ID、邀请秘密、邀请口令的编解码 |
| `src/lib/client/roomclient.ts` | 客户端协议：加入握手、发送与 ack、去重、历史分页、附件上传下载 |
| `src/lib/client/vault.ts` | 本机恢复入口（`roomId` + 秘密 + 创建者令牌），只存 localStorage |
| `src/lib/client/prefs.ts`, `identity.ts` | 设备昵称与偏好的缓存与自定义 |
| `src/lib/client/roomstore.ts`, `virtuoso.ts`, `media.ts`, `notify.ts` | 消息状态容器、虚拟滚动、图片/blob 生命周期、浏览器通知 |
| `src/server/service.ts` | 房间状态机、槽位、序列、幂等销毁、授权校验 |
| `src/server/storage.ts` | 分片读写（异步、有界）、销毁时的目录清理 |
| `src/server/http-api.ts` | `POST /api/rooms`、`/status`、`/history`、`/destroy`、附件分片、`/health` |
| `src/server/ws.ts` | 升级、心跳、广播、离开与销毁通知 |
| `src/server/db.ts` | 建表、迁移、WAL、索引 |
| `scripts/*` | `dev` `build-release` `run-browser-tests` `run-gates` `healthcheck` |

加密相关的包（`@noble/ciphers`、`@noble/hashes`）全部打进构建产物，运行时不向任何 CDN 取加密代码。

## 3. 密钥与认证流程

邀请秘密是客户端生成的 32 字节随机值，出现在 URL 的 `#` 之后，浏览器不会把它发给任何服务器，因此它也永远不会出现在服务端日志、访问日志或 Referer 里。

```
secret(32B, 只在客户端)
 ├─ HKDF-SHA256(secret, "poofspace/v1/msg")   → msgKey
 ├─ HKDF-SHA256(secret, "poofspace/v1/file")  → fileKey
 ├─ HKDF-SHA256(secret, "poofspace/v1/meta")  → metaKey   (文件名 / MIME)
 └─ HKDF-SHA256(secret, "poofspace/v1/authver") → authVerifier
                                              └─ HMAC-SHA256(authVerifier, "…/join") → joinKey
```

服务端只保存 `joinKey`：它够用于验证"你手里有没有邀请秘密"，但**推不出** `msgKey` / `fileKey` / `metaKey`（HKDF 单向）。

加入握手（防重放的零知识证明）：

1. 客户端 `join.hello`，服务端回一个 32 字节一次性 `serverNonce`；
2. 客户端回 `proof = HMAC-SHA256(joinKey, "poofspace/v1/join|<roomId>|<hex nonce>")`；
3. 服务端比对通过才分配槽位。旧的 `proof` 换个 nonce 就不成立，因此不能复用。

### nonce 纪律（同一密钥下绝不重复）

12 字节 nonce 是结构化拼出来的，不是随机取的：

```
nonce = 版本(1) ‖ slot(3) ‖ gen(2) ‖ counter(6)
```

`slot` 由服务端在房间内唯一分配，`gen` 在槽位重发时递增，`counter` 在一个 `(slot, gen)` 对内单调递增。因此同一 `msgKey`/`fileKey` 下两条不同明文不可能撞上同一个 nonce；`counter` 用尽时直接抛 `nonce counter exhausted`，不是静默重用。

### AAD 绑定

- 消息：`<PROTO>|msg|<roomId>|<clientMsgId>`
- 分片：`<PROTO>|chunk|<roomId>|<attachmentId>|<index>`

跨房间搬运、把分片挪到另一个附件、换个消息 ID 重放，都会因为认证标签不匹配而被客户端拒掉（`DecryptError`，`code = DECRYPT_FAILED`），不会渲染出"看起来能用其实是坏的"内容。

分片磁盘/网络格式：`nonce(12) ‖ ciphertext ‖ tag(16)`。

## 4. 数据模型

`meta`（仅 `schema_version`）、`rooms`（状态 `ACTIVE|IDLE_GRACE|DESTROYING|DESTROYED`、`join_key`、上限、`empty_since`）、`slots`（槽位、`gen`、最后心跳、昵称摘要）、`messages`（`seq`、`client_msg_id`、密文、nonce、`UNIQUE(room_id, client_msg_id)`）、`attachments` / `attachment_chunks`（索引与落盘状态）、`session_tokens`（会话令牌）。**没有**房间目录表、创建者映射表、审计表或索引表——七张表就是全部，且每一张都挂在某个 `room_id` 上、随房间一起被清干净。

- 这是一个**临时运行库**：允许为活跃房间或仍在 5 分钟恢复期内的房间保留密文，不允许长期保留任何房间记录；
- WAL + `synchronous=NORMAL` + `busy_timeout=5000` + `secure_delete=ON` + 外键 `ON DELETE CASCADE`；
- 每次销毁 `wal_checkpoint(TRUNCATE)`，空闲页超过 `VACUUM_FREELIST_PAGES` 时再 `VACUUM` 重写文件——只执行 `DELETE` 不等于受控残留已清除，自由列表里的旧页面仍可能被读到；
- 序列号、槽位、房间状态变更都在事务里做，销毁靠状态机 CAS 推进，重复销毁幂等；
- 消息顺序由服务端 `seq` 决定，客户端按 `clientMsgId` 去重，因此同一消息重复到达只会渲染一次；
- schema 从 v1 到 v2 是**原地重建 `rooms` 表**（把旧的"已空房"行认成 `IDLE_GRACE`），不删数据，所以重新部署不会清空仍然有效的房间。

## 5. 生命周期

`ACTIVE → IDLE_GRACE → DESTROYING → DESTROYED`，一旦进入 `DESTROYING` 就不可逆。

1. 创建者二次确认；或最后一个有效参与者离开/连接超时 → 原子进入 `IDLE_GRACE`，同时记下 `empty_since`；
2. `IDLE_GRACE` 期间**什么都不删**：密文历史、附件分片、房间状态原样保留，仍占 `MAX_ROOMS` 名额；
   持有效邀请凭据的任何人重新进入即回到 `ACTIVE`，倒计时取消，回来的是同一间房（不是新建）；
3. 300 秒（`ROOM_IDLE_TTL_SECONDS`，按墙钟计，停机也算）到期 → 原子进入 `DESTROYING`；此后新的请求、
   浏览器刷新、服务重启都不能把它救回来；
4. `DESTROYING`：拒绝加入/写消息/新上传/下载，终止连接与在飞任务（`pendingUploadTtlMs` 回收孤儿上传）；
5. 删 `rooms/<roomId>/**`（含未完成分片与 `.tmp`）→ **确认目录真空**才删库中该房间的行（含 `rooms` 行本身）
   → `wal_checkpoint(TRUNCATE)` → 按阈值 `VACUUM`；
6. 目录没清干净就不删行：房间保持 `DESTROYING`、继续占名额，由清扫按 `DESTROY_RETRY_MS` 重试，
   运维命令 `flushPendingDestroys` 可以立刻补做——绝不把"没做完"报成"已清除"。

已销毁的房间**在数据库里没有行**，所以旧链接、旧邀请码、旧 WebSocket、旧会话令牌与本地缓存都无从复活；
对外它和一个从未用过的房间 ID 答案完全一样（`{"joinable":false}`），这同时就是"不能被枚举"的那一半。
进程重启时：没有 WebSocket 能活过重启，所以所有房间进入 `IDLE_GRACE`；窗口在停机期间已过期的当场清理完成；
停在 `DESTROYING` 的继续把清理做完。

## 6. 界面上的轻量安全提示

聊天室顶部只有一颗锁图标：桌面悬停、移动点击才出现文案，HTTPS 与 HTTP 各一段（逐字写在 `scripts/run-browser-tests.mjs` 的 `HTTPS_COPY` / `HTTP_COPY`，并由台面逐字比对）。加密初始化失败、随机数不可用或密文认证异常时，锁不再是重点——发送会被挡住并给明确错误。首页不重复讲这些。

## 7. 限制与背压

来自 `src/lib/constants.ts`，全部可用环境变量收紧（不能放宽过硬上限）：节点房间数 `maxRoomsDefault = 20`（`MAX_ROOMS`，硬顶 1000）、每房间 100 人（`MAX_PARTICIPANTS_PER_ROOM`，硬顶 500）、恢复窗口 `roomIdleTtlSeconds = 300`、单条明文 `textPlaintextBytes`、分片 `chunkBytesMax = 4 MiB`、单附件 `attachmentBytesMax = 256 MiB`、房间附件总额 `2 GiB`、**全节点**临时额度 `tempBytesMaxNode = 20 GiB`、每人未完成上传额度 `pendingUploadsPerMember = 8`、心跳 15 s（宽限 60 s = 4 个 ping 周期，不能小于 3 个）、槽位宽限 45 s、连接闸门 `connectionsNodeMax = 4000` / `connectionsPerIpMax = 512`。

**名额算法**：`slotsHeld() = COUNT(*) FROM rooms WHERE status IN ('ACTIVE','IDLE_GRACE','DESTROYING')`，
和 `INSERT` 同在一条事务里判定；Node 侧请求处理是同步的，所以并发创建不会各自先看过一遍再一起突破。
达到上限时返回 `503 ROOM_CAPACITY_FULL` + 一句不含数字的提示——告诉调用方"要等"，不告诉它节点现在有多少间房。

**房间之间互相看不见**：每间房自己的 16 字节随机 ID + 32 字节秘密；会话令牌行带 `room_id`，
`authorizeToken(token, roomId)` 只在两者匹配时放行；房间 ID 只是定位符，从不充当授权凭证；
销毁一间房不影响另一间的行、目录与在飞任务（`tests/lifecycle/idle-grace` 第 8 条、`tests/capacity` 第 9 条）。

文件走分片流式读取（有界缓冲 + 有限并发），不会把大文件整个读进内存，也不会占死事件循环；文字、心跳、离开、销毁与上传不互相阻塞（台面与集成测试各有一条腿专门盯这个）。

## 7.1 管理通道为什么不在 HTTP 上

`src/server/admin.ts` 在同一个进程里再起一个 **只绑 `127.0.0.1`、端口由内核分配** 的 HTTP 服务，
端口和一次性令牌写进 `$DATA_DIR/admin-control.json`（`0600`）。请求还要再过一道
`remoteAddress ∈ {127.0.0.1, ::1}` 的判断，且**不看** `X-Forwarded-For`（只有明确开了 `TRUST_PROXY`
才用代理头算连接计数 key）。因此公开监听器上根本不存在可以喊的路由，首页也没有第二个权限体系。
`src/server/admin-cli.ts` 是运维唯一的入口：先印爆炸半径，`data:purge-all` 必须显式确认，
输出只有计数，退出码 `0/1/2/3` 可机器检查；服务在跑时 `--offline` 一律拒绝，避免删掉一个仍被
PM2 打开的数据库文件。

## 8. 打包与发布

`npm ci && npm run build` 产出 `dist/server/*`（自建服务端）与 `.next/`；`npm run release` 用 `scripts/build-release.mjs` 追踪**真实运行时依赖闭包**（不是手删 `node_modules`），生成 `release/poofspace/` 与 `release/poofspace-deploy.tar.gz`，并在收尾对"暂存目录"和"解包后的目录"分别做一轮启动+接口冒烟，结论写进 `release/build-info.json`。`data/` 不进产物、不作为静态目录发布；PM2 以 fork 模式跑单个实例（见 `ecosystem.config.cjs` 与 `docs/DEPLOYMENT.md`）。

## 9. 明确没有做的东西

没有前向保密（同一房间秘密长期有效），没有成员撤销（拿到完整链接就还能解密历史），也没有"抗主动作恶服务器"的保证（服务端能拒服务、能塞密文，只是读不懂明文）。这些不是待办清单里的口误，是设计边界，理由与影响面写在 `docs/SECURITY.md`。
