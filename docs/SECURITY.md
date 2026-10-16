# PoofSpace 安全说明

这份文档写的是**实际做到的事**和**明确没做到的事**。所有"做到了"的句子后面都跟着一条能跑出来的自动化判据；
没有判据支撑的主张一律写在"未提供"那一节里。

---

## 1. 两种被反复混淆的能力

| | 应用层端到端加密 | 连接与客户端代码完整性 |
| --- | --- | --- |
| 保护对象 | 消息/文件内容，即使服务器被完全信任也不暴露 | 传输链路、以及浏览器拿到的 JS 是否被篡改 |
| 由谁提供 | 客户端密钥 + AEAD（本项目自己实现） | 只有 HTTPS/TLS 提供 |
| HTTP 模式下 | **仍然成立**（`crypto.subtle` 缺席时改用打包进产物的 `@noble/ciphers`） | **不成立** |

PoofSpace 的端到端加密不依赖 HTTPS。
但**在没有通过安全验证之前，不得宣称 HTTP 模式具备与 HTTPS 相同的传输安全性**——
本项目对 HTTP 模式的结论是：内容机密性仍成立，链路机密性与代码完整性不成立。

## 2. 威胁模型：谁被视为对手

1. **被动窃听者（同一网络）**：能看到请求/响应与 WebSocket 帧。
   能看到的内容：房间 ID、密文帧及其长度、序列号、在线人数、心跳时序、你访问了哪个页面路径。
   看不到：消息正文、文件名/MIME、文件字节（前提是客户端代码未被篡改）。
2. **服务器本身（半诚实）**：拥有 SQLite 全部行、`rooms/` 全部字节、进程内存、日志。
   规范把它当成**可以读 everything 但拿不到密钥**的一方。
3. **服务器（主动恶意）**：可以篡改/删除/重放它持有的密文、拒绝服务、谎报成员名单、只回旧历史。
   本项目**不抵抗**这一类（见 §7）。
4. **HTTP 下的主动网络攻击者**：可以改写发给浏览器的 JS，从而在加密发生**之前**读走明文与密钥。
   这是 HTTP 模式的真实上限，见 §6。
5. **拿到邀请链接的任何人**：链接是不记名凭据，等于解密权。见 §8。

## 3. 密钥体系（客户端生成，服务器从不持有）

```
secret                     32 字节，浏览器 crypto.getRandomValues 生成，只进 URL 的 # 片段
  └─ HKDF-SHA256(secret, "poofspace/v1/msg")    → msgKey     （消息正文）
  └─ HKDF-SHA256(secret, "poofspace/v1/file")   → fileKey    （附件分片正文）
  └─ HKDF-SHA256(secret, "poofspace/v1/meta")   → metaKey    （文件名 + MIME + 几何信息）
  └─ HKDF-SHA256(secret, "poofspace/v1/authver")→ authVerifier
        └─ HMAC-SHA256(authVerifier, "poofspace/v1/join") → joinKey
```

`joinKey` 是**唯一**进入服务器的派生值，服务器只存它的 32 字节摘要（`rooms.join_key`），
用途仅限于对客户端发起的挑战答做 HMAC 校验：

```
proof = HMAC-SHA256(joinKey, "poofspace/v1/join|" + roomId + "|" + hex(serverNonce))
```

`serverNonce` 每连接随机（32 字节），因此 proof 不可复用、不可跨房间重放。
从服务器持有的 `joinKey` 反推 `secret` 需要破解 HKDF/HMAC（不可行），所以**持有数据库等于拿不到内容密钥**。

判据：
- `secrets carry 256 bits`、`room ids carry 128 bits and survive encode/decode`
- `derives four distinct 32-byte subkeys from one secret`、`HKDF info strings match the documented protocol labels`
- `does not store the invite secret anywhere in the row for a live room`
- `join proof binds roomId and server nonce`、`refuses a cross-room replay of a valid join proof`
- `refuses a join whose proof was computed with a different secret`、`a room id alone is not an invite`
- `cannot open a message with the only key material it stores`（服务器侧用它能拿到的全部材料去解，解不开）
- `leaves no secret or plaintext in the server log stream`

## 4. AEAD 与 nonce

AES-256-GCM，两个等价引擎：安全上下文用 `crypto.subtle`，非安全上下文用 `@noble/ciphers`；
两条路径产出**逐字节一致**的密文并可互解（`produces byte-identical ciphertext from both engines and cross-decrypts`）。

nonce 是 12 字节结构化值，不允许计数器溢出或被越界写入：

```
nonce = version(1B)=0x01 ‖ slot(3B) ‖ gen(2B) ‖ counter(6B)
```

- `slot`：成员在房间里的槽位，服务端分配；同一槽位被回收再发时 `gen` 递增，因此两个时段不会共用计数器空间。
- `counter`：客户端本地单调递增，写入前检查上界（`survives a 2000-message nonce sweep with no repeat`、
  `refuses counters and slots outside the nonce geometry`、`keeps nonces unique across slot and gen re-issue`）。

AAD 把上下文绑进认证标签：

```
消息：  "poofspace/v1|msg|<roomId>|<clientMsgId>"
分片：  "poofspace/v1|chunk|<roomId>|<attachmentId>|<index>"
```

于是"合法的密文 blob 挪到另一个房间/另一条消息/另一个分片下标"必然认证失败，而不是解出错乱明文：
- `seals and opens a text payload bound to room and message id`
- `binds the AAD to room and message id so a copied frame cannot authenticate`
- `rejects a foreign AAD (cross-room replay of a valid blob)`、`fails to open when the room id or message id differs`
- `refuses a chunk moved to another index or another attachment`

完整性拒绝（篡改必须**报错**，不能返回坏字节）：
- `rejects a flipped authentication tag byte`、`rejects a flipped ciphertext byte`、`rejects a wrong key`
- `refuses a ciphertext frame whose byte or tag was flipped on the server side`
- `round-trips a chunk and rejects tampering with any byte`
- `refuses a truncated frame and a bad key length`、`refuses an oversized or malformed envelope`
- `refuses to decrypt a chunk that was tampered with on disk instead of returning corrupt bytes`
- `drops a message the receiver cannot authenticate and says so loudly`

## 5. 附件

- 正文分片用 `fileKey`、`chunk = nonce(12) ‖ ciphertext ‖ tag(16)`；文件名/MIME/几何信息用 `metaKey` 单独密封。
- 分片按块读出→分块加密→分块上传，**从不把整个文件读进内存**；上传队列有并发上界与每成员配额。
- 服务端只写 `attachment_chunks` 字节，不生成缩略图、不做预览、不建明文索引。
- 粘贴是同一个上传路径的另一个入口，不是第二条通道：页面只取剪贴板里的**文件**项（截图、复制的图片、
  复制的文件），剪贴板的**文字**不读、不写、不进消息，仍交给输入框原本的行为。剪贴板来的文件若没有名字
  （浏览器给的是 `image.png` / `blob`），只在**本地**补一个 `粘贴图片-时:分:秒` 式的名字；文件名与 MIME 仍然
  走上面那条 `metaKey` 密封，服务端拿不到明文文件名。
- 一次粘贴或一次多选的多个文件按串行队列逐个加密上传，任何一个失败都不会把别人的字节混进去：每个附件
  有自己的 `attachmentId` 与自己的分片目录，判据 `refuses a chunk moved to another index or another attachment`
  与 `rejects metadata whose declared geometry cannot hold the payload` 覆盖这一点。
- 判据：`round-trips a small file byte-identically with its encrypted filename and mime intact`、
  `stores no plaintext file name or file bytes for an attachment`、
  `round-trips an image through the same pipeline and leaves it decryptable for a late joiner`、
  `rejects metadata whose declared geometry cannot hold the payload`、
  `rejects an attachment whose declared size does not fit its chunk geometry`、
  `expires a stalled upload and removes its partial chunks`、
  `reclaims an upload orphaned by a dead connection, without leaking the room quota`。

## 6. HTTP（含 IP:端口）模式到底还提供什么

**仍然提供**：内容加密与认证。真实浏览器门禁在页面 `isSecureContext=false`、`crypto.subtle` 不存在时验证：
`insecure context crypto: subtle=false secure=false` + 出站帧 0 条明文 + 数据库/临时文件 0 条明文。

**不提供**：传输加密与客户端代码完整性。能改写网页的攻击者可以在加密之前拿走明文与 `secret`。
因此对外表述必须是"应用层端到端加密仍成立，链路安全性不成立"，而不是"HTTP 模式一样安全"。
锁形提示在 HTTP 下就是这句话的短版本，且**只在悬停/点击时出现**：
`http lock tooltip: isSecureContext=false; tooltip matches the protocol`、
`http tooltip makes no false assurance`、`https tooltip makes no false assurance`。

`upgrade-insecure-requests` 只在 HTTPS 监听时才加进 CSP（`does not tell an http page to upgrade its own subresources`），
否则 HTTP 部署会被自己的头把子资源全部打死。

## 7. 明确没有做的（不要对外宣称）

1. **没有前向保密 / 后向保密**：`secret` 是房间长期密钥，一条消息的密钥不随时间轮换。
   一旦 `secret` 泄露（链接被转发、某台设备被取证），该房间**全部历史**都可解密。
2. **没有成员撤销**：没有密钥轮换机制。被移出/离开的成员只要还留着链接和 `secret`，
   就仍能加入（若房间未销毁）并解密历史。房间内的"移除成员"只能撤销**会话令牌**，不能撤销知识。
3. **不抵抗主动恶意服务器**：服务器可以删掉/回退它持有的密文、只回旧历史、谎报名单、
   拒绝服务、把某个客户端的数据悄悄丢掉。客户端无法区分"服务器错了"和"内容真的没有"。
   唯一不受影响的性质是它**读不到内容**。
4. **没有第三方审计/形式化验证**：加密构造是标准原语（AES-256-GCM + HKDF-SHA256 + HMAC-SHA256）+ 本项目自己的
   nonce/AAD 方案，方案有自动化攻击判据，但没有外部审计报告。
5. **没有元数据保护**：房间 ID、密文长度、消息条数与时间序、成员数、分片数都会暴露给服务器。
6. **没有去匿名化/身份验证**：昵称是加密的，但不证明身份；任何人都可以用任意昵称。
7. **没有密钥确认/透明度日志**：客户端不会验证"这个房间 ID 确实对应我邀请的人生成的那把钥匙"以外的东西。

## 8. 邀请链接是不记名凭据

`<base>/room/<roomId>#<secret>`

- 浏览器不会把 `#` 片段发往服务器；服务器代码也没有任何路径读取它（`keeps the secret in the fragment only`）。
- 进入房间后客户端立刻把当前历史条目换成不带片段的 pathname（`RoomView.tsx:148` 的 `history.replaceState`），
  所以地址栏里不再留着秘密；浏览器门禁那一把刀（N1a）就是打在这里扑空的——那一刻 `location.hash` 已经是空串。
  秘密此后只活在页面内存与 §9 的本地凭据库两处，而不是"URL 上随手可复制"的状态。
- 响应头 `referrer-policy: no-referrer`，站内脚本不向任何第三方 origin 发请求（`names no third-party origin any script could be fetched from`），
  邀请密钥不会沿 Referrer 泄漏（`keeps the bearer invite secret out of the referrer chain and out of frames`）。
- **代价**：任何拿到完整链接的人都能加入并解密；转发到群聊/邮件/截图等于公开密钥。
  这条限制要写在使用说明里，而不是靠产品机制掩盖。
- 邀请口令形式（去掉分隔符的一串 base64url）也携带同样的密钥：`parses an invite code that carries the key material`、
  `preserves base64url alphabet characters inside an invite code`、`ungrouping tolerates the pasteable dashed form`、
  `rejects a short secret`、`rejects malformed input instead of guessing`、
  `accepts a structurally valid code but does not authorize it`。

## 9. 本地存储：`localStorage` 里的密钥是真实风险

恢复入口（`roomId`、`secret`、`creatorToken`）存在本设备 `localStorage` 中，
它把"设备被访问 / XSS"变成了新的对手面：

- 任何能跑 JS 的人都能读走 `secret`。因此 CSP 禁 `object-src`/`base-uri`/`frame-ancestors`、
  只允许 `script-src 'self'` + Next App Router 必需的 `'unsafe-inline'`（见 §10 的坦白），无第三方脚本。
- 只存**必要凭据 + 非敏感偏好**：不缓存明文历史、不缓存明文附件；进入房间时先在线核验状态再重新拉密文
  （`refuses history access without a live room session`、`lets a late joiner decrypt the full history through pagination`）。
- 核验读的是那**一个位**（`joinable`）。为恢复期内的房间仍然可进 → 入口保留并可直接回去；
  房间已过期销毁、或这个 ID 从未存在 → 服务端答 `joinable:false`，本机**立刻删除该入口**，绝不靠缓存重建房间
  （`answers a room status probe with one joinability bit and nothing else`）。
  注意"服务连不上"是第三种答案（`UNKNOWN`）：那入口保留但标成待确认，不会假装房间已经没了。

## 10. CSP 的坦白

```
default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self';
connect-src 'self' ws: wss:; worker-src 'self' blob:;
object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'
```

`script-src` 里的 `'unsafe-inline'` 是**已知妥协**：Next.js App Router 把 flight 载荷以行内
`<script>self.__next_f.push(...)</script>` 流式写入，没有 nonce 就整页不 hydrate、聊天室直接不可用。
Next 16.4 不提供给这些脚本加 nonce 的接口。
缓解：不允许任何第三方 origin、`object-src 'none'`、`base-uri 'none'`、`frame-ancestors 'none'`、
无用户 HTML 注入路径（正文一律作为文本渲染，见 §11）。
这条限制登记在欠账清单里，不做"已消除"的宣称。

判据：`allows the inline bootstrap scripts the page needs to hydrate`、
`names no third-party origin any script could be fetched from`、
`reports room status online without exposing any key material`、`publishes limits and the base URL without leaking secrets`。

## 11. 内容渲染

用户内容（消息正文、昵称、文件名）一律作为**文本节点**渲染，不经过 `dangerouslySetInnerHTML`，
不进 `href`/`src` 的原始拼接；链接化只接受 http/https scheme。
复制/选区走 `textContent`，不回解析 HTML。

## 12. 授权与销毁的凭据边界

- 只有创建者的 `creatorToken` 能销毁，且必须二次确认（UI 层）+ 服务端令牌校验（`403`）：
  `rejects a forged destroy token, a missing token, and a replay after destroy`。
- 销毁后所有旧凭据一起失效：`kills every old credential: rejoin, append, download and token all refused`。
- 并发不能复活房间：`cannot be reactivated by an in-flight writer racing the destroy`、
  `is idempotent under concurrent destroy requests`、`finishes an interrupted destroy and never revives a destroyed room`。
- 清理以**受控存储清干净**为准，不是只删数据库行：
  `clears database rows, attachment files and memory, and proves it`（断言行数、`rooms/<id>` 目录为空、内存态无残留）、
  `prunes attachment directories that have no live room behind them`、
  `cleanup reaches the attachment directory, the partial chunks and the .tmp files`（连 `*.tmp` 半写文件一起扫），
  以及把整个 `DATA_DIR` 按字节读一遍找旧密文的 `after a full purge no room and no restore path is left`。
- **已销毁的房间不留任何数据库记录**（没有 `DESTROYED` 墓碑、没有保留期清扫）：
  `leaves no room record to expire later — there is no retention ledger at all`。
  这条同时是"严禁长期保存房间记录"和"不能被枚举"的两半——没有行可查，也没有可复活的对象。
- `IDLE_GRACE` 里保留密文是**有期限的例外**，不是持久化：房间空了以后 300 秒内原样保留（可回原房间），
  到期即进入销毁；等待期间房间仍占 `MAX_ROOMS` 名额，清理没证明完成就不放名额。
- 会话授权说的是 `(slot, gen)` 而不是"槽位号"：槽位号会被复用（每次重新加入 `gen + 1`），所以一个属于**旧
  generation** 的迟到事件（关闭、心跳、上传预约）既不能撤销、也不能续期现在真正占着该槽的成员；
  反过来，一条 `connected=1` 却背后没有会话的行会在 `slotGraceMs` 之后被心跳清扫回收，否则名额被永久占住，
  别人再以 `ROOM_FULL` 被拒。判据在 `tests/lifecycle/slot-reclaim.test.ts`（迟到 leave、迟到心跳、
  旧 generation 的上传预约、被遗弃的行的回收，外加一条反向证人：本 generation 的心跳必须保住成员）。
  这只是**会话**边界，不是成员撤销——§7 第 2 条依然成立：离开的人只要还留着链接就还能再进来。

## 13. "销毁"能承诺什么，不能承诺什么

**能承诺**（有判据）：服务器侧该房间的数据行（**包括 `rooms` 行本身，一行不剩**）、WAL 落盘后的残留页、
附件目录全部文件（含未完成的 `.tmp`）、未完成上传任务、内存中的房间态与连接，以及"本设备的过期恢复入口"被删除；
旧链接/旧口令/旧 WebSocket 都不能让房间回来。数据库层面 `secure_delete=ON` + `wal_checkpoint(TRUNCATE)`，
并在空闲页超阈值时 `VACUUM` 重写文件——所以"只执行了 `DELETE`"这种说法在本项目里不成立。
全量清理（`npm run admin:data:purge-all`）额外把 `-wal` / `-shm` 一起处理，并在证明为空后才恢复服务；
证明不了就保持维护态并如实报错。

**不能承诺**：用户已经截图、复制到其他应用、下载到其他位置的文件、
以及底层存储介质上尚未被覆盖的物理痕迹（SSD 磨损均衡与掉电映射不在应用层可控范围）。
本项目**不宣传"绝对不可恢复"**；能说的只是：不存在可用的应用层恢复路径、受控存储已被清理、
且服务器拿不到解密所需的秘密。

## 14. 传输与代理

- `TRUST_PROXY` 默认关闭：默认**不读**任何外部 `X-Forwarded-*`
  （`ignores X-Forwarded-* unless a proxy is explicitly trusted`、`derives the scheme from the socket when there is no proxy`）。
- TLS：`TLS_CERT_FILE`/`TLS_KEY_FILE` 同时给出时服务器直接以 HTTPS 提供服务，
  `claims transport security only on the encrypted listener`（HTTP 监听不会冒充自己加密），
  `creates a room over TLS and a wss upgrade reaches the join handshake`、
  `serves health over TLS verified against the issuing CA, and the leaf names the IP`、
  `refuses a client that does not trust the issuing CA`。
- Nginx 反代示例见 `deploy/nginx.conf.example`。

## 15. 日志

`src/server/log.ts` 的 `scrub()` 是唯一出口：键名含
`secret|proof|joinkey|token|nonce|key|fragment|authorization` 的值一律替换为 `[redacted]`；
字符串里的 `#…` 片段被剥掉；`Buffer`/`Uint8Array` 只打长度；单条字符串截 300 字符。

除此之外还有一条更硬的规定：**代码路径不打印房间 ID**。房间 ID 是邀请链接的前半段，
而 `pm2` 会把 stdout 落成日志文件——所以按补充规范，那也算"含敏感房间信息的日志"。
落地上不是靠在 `scrub()` 里加正则掩码（那样以后新加一行 `logger.info(..., { roomId })` 会被掩掉、
判据永远是绿的、等于自废），而是：

- 生命周期事件只打计数与原因（`room entered idle grace`、`member joined`、`room destroyed`），不打 ID；
- 存储失败的错误**只取 `err.code`**（`EBUSY` 之类），因为 Node 的 `message` 里带着
  `.../rooms/<roomId>/...` 这个路径；
- 判据 `the log stream never carries a room id, a secret, a link fragment or plaintext`
  用 `captureLogs()` 抓真日志流，并且**故意把失败分支也走一遍**（把 `removeRoom` 打成抛错再销毁一次），
  否则最容易漏的那条路径没有被扫过。

还有一条容易被忽略的：**不给每次创建/加入/退出/销毁留长期审计记录**。房间 ID 与时间戳的组合本身就是一份
"谁在什么时候开过一间房"的台账，所以这些事件只作为瞬时日志出现，库里没有对应的表或行。

运维仍要注意：反向代理（Nginx）的访问日志不在本进程管辖内，
`deploy/nginx.conf.example` 里明确要求不要把 `$request_uri` 打进日志。

## 15.1 内部运行状态不可枚举

补充规范禁止"公共房间发现接口 / 全站房间列表 / 供普通用户查询当前房间数量"。落地成四条判据：

| 面 | 现在的回答 | 判据 |
| --- | --- | --- |
| `GET /api/health` | 只有 `{ok, proto}`；计数类字段一律不出现 | `serves a liveness-only health document, with no room counters to enumerate`（`/uptime|rooms|online|messages|connections/` 命中即红）；`scripts/healthcheck.mjs` 也在客户端方向把这几把尺子对着自己的探针下了一遍 |
| `GET /api/rooms/<id>/status` | 一个位：`{"joinable":bool}` | `answers a room status probe with one joinability bit and nothing else`；在线人数、上限、花名册只能在**已授权**的 WebSocket 里读到 |
| 未知 / 已销毁房间 | 两者答案完全一样 | `answers a status probe for an unknown room id exactly like a destroyed one` |
| 房间列表 | 不存在这个路由 | `GET /api/rooms` → `NOT_FOUND`（`a refusal says nothing about how full the node is, and there is no room list to read`） |

容量满时的 `503` 提示是写死的一句话，**不含数字**：调用方知道"要稍后再试"，不知道节点此刻握着 19 间还是
190 间房。`service.stats()` 仍然存在，但它只在进程内被本地管理通道读取，从不出现在公开监听器上。

## 16. 攻击验证 = 这些判据，不是"有加密函数"

规范要求的"必须有真实密钥流程和攻击验证"落在这些地方：
伪造 proof / 跨房间重放 / 篡改密文与标签 / 挪动分片下标 / 磁盘上改字节 /
伪造 creatorToken / 重放销毁 / 在飞的写任务与销毁赛跑 / 缺密钥的客户端尝试解密 /
服务器拿自己存的材料尝试解密 / HTTP 下摘掉 CSPRNG 看它会不会退回明文。
每一条都是可跑出来的判据，运行结果见 `docs/TEST-REPORT.md`。
