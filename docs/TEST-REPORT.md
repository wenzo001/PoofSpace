# PoofSpace 测试报告

- 日期：2026-10-15 起，最后两轮（用户手测的八条 + 交付前收尾）在 2026-10-16
- 现场：Windows 10 x64（10.0.26300）、Node.js v24.16.0（abi 137）、`npm run gates` / `npm run release` / vitest / 真实 chromium
- 仓库：`D:\code\poofspace`。各轮报告的提交状态以 §7.6 结尾为准：补充规范与开源发布这两轮**经用户明确授权后**建立了本地提交与注解标签 `v1.0.0`；**建仓与推送由执行人自己做**（他选的正是"只做本地 commit + tag"）。在此之前，本报告写作时仓库为 0 commit、全部路径 untracked。
- 判定口径：**PASS / FAIL / SKIP 三态；SKIP 永远不算通过**。下面每一条 PASS 后面跟的是它自己的读数，
  不是"看起来应该没问题"。所有原始日志留在 `scratch/`（构建/门禁输出）与 `release/build-info.json`。

## 0. 一句话结论

自动化验收 **16/16 PASS、0 FAIL、0 SKIP**（`GATES_EXIT=0`，台面 `scratch/gates-oss-final2.log`，
判定对象是那一次台面所用的整包（交付前"只重拷文档"的再打包与它的差别见 §7.6 末）：
`build-info.json` 的 `builtAt=2026-10-15T08:20:02.497Z`、`nextBuildId=SYQv27QbLjMho6dSA1zuX`、
`abi=137`，包体 `release/poofspace-deploy.tar.gz` 96,096,390 字节，产物顶层含 `LICENSE / README.md / README.zh-CN.md / CHANGELOG.md`）。
同一个包的**前一次**整台面是 `13 PASS / 3 FAIL`，三条红全部来自浏览器线的一条腿（`https lock tooltip` 建房 30 s 超时），
单跑该腿绿、台面重跑整条绿 —— 这是一次未复现的间歇红，按签名登记在 D20，不当成"已排除"，也不拿第二次绿抹掉第一次红。

**v1.0.1 这一轮的最新一次整台面**（`scratch/certify-v101c.log`）：**16/16 PASS、0 FAIL、0 SKIP**，`GATES_EXIT=0`；
157 条自动化判据（`npm test` 已拆成两次调用：148 + 9），浏览器线 16 条腿。
这轮台面**不是一次就绿**：今天共整跑 9 遍，两次全绿（`certify-table2.log`、`certify-v101c.log`），七遍至少红一条；
红的分布是 T5 五次、T4 四次（同一遍可两条一起红），签名分别是抖动腿"帧根本没到"（D27）与压力线的
两种形状（子进程静默死掉 / 只剩 `long-run storage hygiene` 一条红，D26）。两条都登记在册，
没有用"再跑一遍就绿"冒充排除；该抖动腿在换成"按到达定界"之后单独整跑 11 遍：绿 9、红 2，红的那两遍
读数与其它红遍同签名。逐刀台账在 `scratch/mutation-ledger-spec8.md` 的"追加""追加二"两节。

**第四轮（同日更晚：用户手测出来的八条界面与滚动问题）**：最新一次整台面 `scratch/gates-G.log` =
**16/16 PASS、0 FAIL、0 SKIP**、`GATES_EXIT=0`；157 条自动化判据（T1 62 + T2 26 + T3 30 + T4 9 + T6 30），
浏览器线 **21 条腿**（§2 的逐条读数取自 `scratch/lane-21e.log`，与台面里那条 T5 同一棵树）。
**这一轮台面不是一遍就绿**：同一棵树今天整跑 5 遍 —— `gates-C` 16/0/0、`gates-D/E/F` 各 **15 PASS + T4 崩**
（`0 files, 0 tests` + `ERR_IPC_CHANNEL_CLOSED`）、`gates-G` 16/0/0。崩与绿之间目前唯一抓到的差别是台面
自己打印的占用读数：**崩的三遍 `chrome=9`，绿的两遍 `chrome=0`**（node 数与空闲内存都不区分），登记在 D26；
浏览器线另有两遍红在抖动腿（整跑红、单跑绿），登记在 D27。八条要求逐条的读数与七把刀在 **§7.9**，
两条没做到的事在 **D28**（整页历史落地那一步仍差一个滚轮步长）与 §7.9 末（"原生感/弱化"没有可证伪判据）。
这一轮判定的是**补充规范《临时数据、房间销毁、容量限制与服务器管理》落地之后的树**：
`ACTIVE → IDLE_GRACE(300 s) → DESTROYING → DESTROYED`、`MAX_ROOMS=20` 的名额账、销毁后不留房间记录、
超出 `DELETE` 的存储清理（WAL/SHM/自由页）、以及只在本地跑的两条运维命令。新增的 30 条治理判据与
它们各自的变异证人见 **§7**；上一轮（正文规范 + 部署补充规范）的读数仍留在 §1–§6，未被这一轮推翻。

**交付前收尾（同日更晚，打包与认证口径）**：整台面再跑一遍 `scratch/gates-H.log` = **16/16 PASS、0 FAIL、0 SKIP**、
`GATES_EXIT=0`（B1 17.6 s、B6 98.7 s、B4 19.9 s、B8 15.5 s、T1 62、T2 26、T3 30、T4 9（68.5 s，
台面自己打印 `machine before[node=12 chrome=0 memFreeMiB=5781/32519] after[…5556…] exit=0`）、T5 21 条腿、T6 30 ⇒ 合计 157 条）。
这一遍判的包是 `builtAt=2026-10-16T10:15:09.887Z`、`nextBuildId=tl6vFQcpRtsH_IQY5mvaC` 那一份，
而它自己的 B1 又把这棵源码重编译成了另一份 `-B9qQbv70PAzhg5jAT6av` —— §7.10 把"台面先重建、再判已在盘上的那一包"
这个结构性错位写清楚了，不靠调顺序糊过去。收尾这一轮另外做的事：把包里指向却没随包出去的
`docs/DEBT.md`、`docs/ARCHITECTURE.md` 补进清单，并给打包审计加了一条文档闭包判据（§7.10）。

规范 §13 的十条验收标准与补充规范 §8 的三族验收测试都有判据覆盖；**尚未做到或只做到一部分的事全部列在
`docs/DEBT.md`**（D15–D19 是这一轮新登记的），本报告不把它们说成已完成（§5 给了摘要）。
过程中台面确实红过一次（T4，14 PASS/1 FAIL），那一条是真缺陷、已修并重跑，见 §1.1 与 D14；
这一轮另有一次全量 7 条红，同样是真缺陷（静默成员的保席只认应用层 ping），修完转绿，见 §7.4。

## 1. 门禁总表（`npm run gates`，严格模式）

| 门 | 判据 | 结果 | 读数 |
| --- | --- | --- | --- |
| B1 | `npm run build` 从干净树跑通（客户端 tsc + server tsc + next build） | PASS | `client tsc=ok server tsc=ok next build=ok` |
| B2 | 产物含生产依赖闭包、原生 sqlite 二进制、静态资源，且不含禁带项 | PASS | 60 个包树（win32/x64/node v24.16.0）；native=`better_sqlite3.node`；静态文件 13；禁带路径 none；缺失 none；`runtime data: none shipped` |
| B3 | 暂存树与**解压后的 tar 包**都能独立启动并服务 API+WS | PASS | `smoke=standalone-production-boot`，`stagedCopyVerified` + `extractedTarballVerified` 均 true；两条链各跑完 10 步冒烟 |
| B4 | PM2 以 fork/1 实例启动打包后的服务、重启、跑**产物里的运维命令**并删除 | PASS | health 重启前后均 true；`exec_mode=fork_mode instances=1`；create=201；重启后 `joinable=true`；`shipped admin disconnect-all exit=0 cleaned=true effect=true`（收尾读数 `roomsActive=0 roomsIdleGrace=0 roomsDestroying=0 slotsHeld=0 maxRooms=20`、`resumed=true paused=false`）；restart/delete 退 0 |
| B5 | SQLite 与房间临时数据跨重启保留，且不被发布覆盖/携带 | PASS | 产物内运行数据：none；两条启动链各自验过"重启后邀请仍可进入（恢复窗口内）、已销毁房间不复活" |
| B6 | HTTP IP:端口 与 HTTPS 均可创建/加入/使用 | PASS | http：`insecure context crypto` 绿；https：`history decrypts`、`https lock tooltip` 绿 |
| B7 | 真实浏览器里跑应用层加密、授权与历史（两种模式） | PASS | `home two entries`、`insecure context crypto`、`history decrypts`、`no rng no send`、`virtual list geometry`、两个 tooltip 全绿 |
| B8 | WebSocket 在 http / wss / 异常断线后可用 | PASS | security+lifecycle 6 文件 56 条绿（含 wss 握手、代理信任、重连补拉、销毁 vs 重连、心跳宽限比例、**协议 pong 续席**） |
| B9 | 安全上下文 API 缺失时**绝不静默退回明文** | PASS | `create requests=0`、`.notice-error` 命中、未进入 `/room/...`、页面未崩 |
| B10 | 锁形提示与实际协议一致、不作虚假保证 | PASS | `isSecureContext=false` 时显示 HTTP 文案、true 时显示 HTTPS 文案，逐字比对 |
| T1 | 功能线（创建/分享/加入/恢复、昵称、分页、容量） | PASS | 3 文件 62 条 |
| T2 | 安全线（静态无明文、服务端不可解、伪造/重放/跨房间被拒） | PASS | 2 文件 26 条（本轮多的那一条是 `confines the dev eval exemption to the development policy`，见 §7.7 与 D22） |
| T3 | 生命周期线（`ACTIVE→IDLE_GRACE(300 s)→DESTROYING→DESTROYED`、重启、凭据失效） | PASS | 4 文件 30 条（含 299 s 回原房间、301 s 被拒、刷新不销毁、宕机过期、房间互不影响） |
| T4 | 性能线（100 成员、广播、重连抖动、大文件与文字并行、不增长） | PASS | 2 文件 9 条，71.9 s；台面自己打印占用与退出码：`machine before[node=13 chrome=0 memFreeMiB=7243/32519] after[node=14 chrome=0 …] exit=0` —— **这一遍绿的时候 chrome=0，而今天崩的三遍都是 chrome=9**，第一条正向线索。串行跑（`--no-file-parallelism`）的理由见 §1.1 与 D13，崩的登记在 D26 |
| T5 | 真实浏览器线整体 | PASS | 21 条腿全绿（逐条读数见 §2；本轮新增五条腿与三处换形，见 §7.9。它在整跑里红过两次，签名是抖动腿「帧根本没到」而单跑全绿 —— 登记在 D27） |
| T6 | 治理线（`MAX_ROOMS` 名额账、严禁长期保存的清理证明、本地运维命令） | PASS | 3 文件 30 条；`every tests/ directory is claimed by a lane`（这条腿还先把"磁盘上的测试目录有没有台面认领"双向差集扫了一遍，漏一个就 FAIL） |

### 1.1 全量 vitest（并发跑整棵 `tests/`）的三次独立读数 —— 压力腿的抖动率在这里

`npm test` 与台面 T4 的区别是**并发**：`npm test` 让 10 个测试文件各自 fork 并行跑，
台面 T4 只跑 `tests/perf` 且串行。同一棵树、安静机上三遍的实测：

| 遍 | 时刻 | 读数 | 失败形状 |
| --- | --- | --- | --- |
| ① | 12:29（紧接一整条台面之后） | `1 failed \| 9 passed (10)`，`2 failed \| 113 passed (115)` + 1 条 Unhandled Rejection | `stress.test.ts` 的"传输期间文字仍可 ack"红在 `upload reservation timed out`（客户端等 `upload:ready` 的 10 s 定点超时），随后"不留被遗弃的预约"红在 `PENDING` 计数 1≠0 —— **第二红是第一红的级联**（第一颗没跑完的上传把那行留在 PENDING，直到 `pendingUploadTtlMs` 才被清扫） |
| ② | 04:31（空机） | `1 failed \| 9 passed (10)`，1 条断言红 | `stress.test.ts:155` 的 reconnect churn（100 人反复掉线/重连）红 —— 正是 D11 记的那格 |
| ③ | 04:32（空机、紧接 ②） | **`10 passed (10)`，退 0** | 无 |
| ④ | 13:49（补充规范那一轮的全量并发） | `7 failed / 144 passed`，整文件 `stress.test.ts` 红 | 签名换了：不是 worker 崩、也不是 97/100，而是**99 个客户端都 `join:ok`、库里 `slots WHERE connected=1` 只剩 3**。这一条又是真缺陷（静默成员的席位只由应用层 ping 续），修完 ⑤ 转绿；见 §7.4 |
| ⑤ | 13:57（同一把刀撤掉之后复跑） | **`152 passed / 0 failed`**，85.1 s | 无 |

⇒ **这三遍红不是"仪器抖动"，其中两条是一条真缺陷**：`stress.test.ts:155` 的"心跳清扫不得摘掉活着的成员"
读到 `{rows:97, online:97}` —— 台账两边相等，所以不是行泄漏，而是**3 个 socket 仍开着的成员被 `sweepHeartbeats()` 摘掉**。
根因：出厂的 `heartbeatGraceMs=25 s` 只有 `heartbeatClientMs=15 s` 的 **1.7 倍**，20 路并发重连的 30 s 风暴里一次 ping 没赶上就判死；
移动端后台把定时器节流到 30–60 s 时同一个缺口更宽（规范 §7 正是禁止"切后台即视为离开"）。
处置：grace 提到 `60_000`（4 个 ping 周期），`tests/helpers/testbed.ts` 的默认值与 `LIMITS` 成对，
并新增静态比例判据 `ships a heartbeat grace that tolerates several missed pings`
（证人：把常量改回 `25_000` 那条腿立刻红 `expected 25000 to be greater than or equal to 45000`，改回 `60_000` 立刻绿）。
**注意记账口径**：这条新判据是本批自己加的，不算本批的证人；本批的证人是台面 T4 本身 —— 改前 `FAIL (65.0s)`、改后 `PASS (64.6s) 2 files, 9 tests`
（`scratch/gates-final3.log` vs `scratch/gates-grace.log`）。剩下那条 12:29 的"10 s 定点预约超时"未复现，按 D13 单独记账，不当成已修。

## 2. 真实浏览器线的逐条读数（chromium，21 条腿 / `LANE_EXIT=0`）

`node scripts/run-browser-tests.mjs` 在 `http://poof.insecure:PORT`（非安全上下文）与
`https://127.0.0.1:PORT`（真 TLS）两个来源上各起一台**独立 DATA_DIR** 的服务，最后一次全绿的读数
（`scratch/lane-21d.log`，逐字截断到行宽）：

```
PASS recovery entry disappears after destroy: other device's card before=1 after=0; server said
     not-joinable=true; vault entry left=false; states=none
PASS served html makes no transport assurance: status=200; tooltip present in first paint=true; https
     claim in served bytes=false; http-warning copy present=true
PASS home two entries: primary buttons ["创建聊天室","加入聊天室"]; account affordances 0
PASS insecure context crypto: subtle=false secure=false; marker rendered=true; plaintext in 0 outgoing
     frames: 0; in sqlite: false; in room temp files: false
PASS history decrypts for a late joiner: guest rendered the host message 1 time(s); room shown
     ri6vna5vcw2gqdhbhakl2olzqm
PASS http lock tooltip: isSecureContext=false; tooltip matches the protocol; before opening it the text
     claimed https=false
PASS no rng no send: renderer crashed=false; navigated to http://poof.insecure:63383/; create
     requests=0; notice count=1; notice
     text="CSPRNGunavailable:crypto.getRandomValuesismissinginthiscontext"; page errors=0 []
PASS browser notification content: backgrounded+granted notifications=[{"title":"收到一条加密消息","body":""}]
     (expected exactly 1, message marker absent); foregrounded+granted total=1 (expected 1);
     backgrounded+denied total=1 (expected 1) while all three bubbles rendered
PASS virtual list geometry (tawwdm): sent 120: rendered rows 16, bubbles 16, sizer 7680px vs viewport
     594px, short rows 0, stacked rows 0
PASS pinned list holds on incoming: frames 56/56/74; sizer-growth at 25ms/22ms; inbound-frame seen at
     25ms/22ms of 926/1223ms sampled; end-of-single-window: sh=1840 hasSingle=true rows=13
     sender-had-written=24 frames (sender open at 256ms); reader rows=13 sawSingle=true sawBurst=true
     received=28 notice="" ws=[{"t":112,"kind":"open","code":0,"msgs":28}]; sender failed=0 sending=0
     written=26 tail=["抖动探针-单条 短短短","抖动探针-多行\n第二行内容 ","抖动探针-第二条"]; idle travel 0px over 1 position(s);
     single arrival: travel 80px reversals 0 sizer +80px vs row 79.6px distance 0; burst: travel 179px
     reversals 0 sizer +179px vs row 79.6px distance 0; room pp5fbi
PASS copy control reveals and honors the selection: hover: opacity 0->1; selected "复制判据探针：前半"
     copied="复制判据探针：前半" whole=true; touch: coarse=true hoverNone=true opacity=1 pill=22x40px band=44x45px
     reach {"up":22,"down":0,"left":3,"right":2} under="div.list"
PASS first run names the device and identity reaches peers: gate offered=1 roomIdBefore=0
     suggestion="曹伟禾" reroll="严明野" cached="严明野"; peer gate=1 peer nick="杨乐晨" author label seen by
     peer="严明野"; own row av=0 author=0 h=63.6 vs peer av=1 h=79.6; room yopudc
PASS an uploaded image reaches the other device: peer rows 1, img.thumb 1, naturalWidth>0 1,
     placeholders 0; room bqi7zs; bytes 326
PASS joined rooms appear as history on the home page: section "历史" rows ["#7oclhwr"] wants 7oclhwri
     state "房间仍在进行"
PASS scrolling up through history keeps the row you are looking at: joiner found 13 mounted row(s) in a
     101-message room, row height 79.6px (list 4092px); reader gestured up 3640px in 14 step(s) and the page
     ended -528px further down than it started; older pages seen 1; list grew 3908px; steady worst 0px over
     13 step(s); page-arrival worst 260px over 1 arrival step(s); overall worst 260px; steps ["0:0px rows16
     sh4080 top3226","1:0px rows19 sh4068 top2954","2:0px rows20 sh4052 top2678","3:0px rows19 sh4040
     top2406","4:0px rows19 sh4028 top2134","5:0px rows19 sh4016 top1862","6:0px rows20 sh4000
     top1586","7:0px rows19 sh4000 top1326","8:0px rows19 sh4000 top1066","9:0px rows19 sh4000
     top806","10:0px rows20 sh4000 top546","11:0px rows17 sh4000 top286","12:-260px rows19 sh8000
     top4286","13:0px rows19 sh8000 top4026"]; room 4gbc6u
PASS a paste sends every file the clipboard carries: clipboard handed 3 item(s) (3 files); rendered img
     2 decoded 2 colours ["#3266cc","#cc3467"] distinct=true, file cards 1 named ["剪贴板里的文件.txt"], queue left
     []; room jq7mdx
PASS a file card keeps its name, size and button in place: card 467x40 overflow 0px; icon 32x32; text
     column 327px; name 327px; size "1.3 KB" 17px tall; button inside=true; room b5kxnw
PASS button and avatar labels sit on their own center line: room offsets
     {"send":{"dy":0,"h":44,"th":18},"expand":{"dy":-0.5,"h":32,"th":15},"avatar":{"dy":-0.5,"h":28,"th":15},
     "hoverChip":{"dy":-0.5,"h":22,"th":14}}; home
     [{"label":"创建聊天室","dy":0},{"label":"加入聊天室","dy":0},{"label":"校验中","dy":-0.5}]; worst 0.5px over 7
     control(s); room gg2wha
PASS the full-text dialog scrolls and keeps its buttons on screen: box 5.1x taller than itself; modal
     559px in a 720px viewport; buttons inside=true; scrolled to end=true; tail "0 行 判据正文"; room mgxvtw
PASS destroying leaves the room and returns home: creator path "/", member path "/", server
     not-joinable=true (after 1 polls)
PASS https lock tooltip: isSecureContext=true; tooltip matches the protocol; before opening it the text
     claimed https=false
```

要点：
- `insecure context crypto` 这一条是在 `http://poof.insecure:PORT`（解析到 127.0.0.1 但**不是安全上下文**）上跑的，
  等价于运维在 `http://<局域网 IP>:3000` 看到的情形：`crypto.subtle` 缺席，走打包进产物的纯 JS AEAD，
  并把"出站帧 / SQLite 文件 / 房间临时目录"三处都扫过明文标记 ⇒ 0 命中。
- `virtual list geometry` 打在**渲染后的几何**上（DOM 行数、占位高度、视口高度），不是"组件存在"。
- `browser notification content` 用第二台设备（独立 context）收消息，把"后台恰好一次 / 前台不弹 /
  未授权不弹 / 通知面不含房间材料"四件事一次跑完；它的手术刀见 §3.1。
- `pinned list holds on incoming` 的两个时刻列（`sizer-growth` 与 `inbound-frame`）是**故意分开记的**：
  绿的时候它们重合（24ms/24ms），红的时候后者是 `never` ⇒ 一眼分辨"帧没到"与"页面包住了不画"。见 §7.7 与 D27。

> 工装说明：`node scripts/run-browser-tests.mjs --only <子串>` 只跑被点名的腿，用于给单条判据下刀而不必整跑全条线。
> **它不能读成台面结论** —— 过滤后的那一趟会自己记一条 `SKIP lane scope: 跑了 N/21 条腿`，退码因此是 1；
> 只有不带 `--only` 的整跑（本报告 §2 与台面 B6/T5）才是 `PASS`。

## 3. 判据自己的证人（变异测试）

一条门禁在说"绿"之前先被证明"会红"。本轮对新增的浏览器腿下了两把刀，且每把刀都有**产物层**证人
（`BUILD_EXIT=0` + 客户端 chunk 哈希变了），避免"刀没进包 ⇒ 误判成判据没牙"：

| 刀 | 破坏的东西 | 期望的红 | 实际读数 |
| --- | --- | --- | --- |
| KNIFE-1 | 在没有密钥材料之前就去 `/api/rooms` 要房间 | `no rng no send` 的 `refused` 臂 | `create requests=1` ⇒ FAIL（撤刀后 `=0`） |
| KNIFE-2 | `catch` 里吞掉错误，让 `.notice-error` 永不渲染 | 同一条腿的 `complained` 臂 | `notice count=0; notice text=""` ⇒ FAIL（撤刀后 `count=1`） |

两把刀各自只红依赖它的那一格（另一格保持真），这正是"每条判据各有牙"的证据。
`stayedOut`（没进房间）这一臂**还没单独下过刀**，已按可证伪口径登记在 `docs/DEBT.md`。

### 3.1 浏览器通知那一格（`browser notification content`）的五把刀

这条腿一次跑三个现场（后台+已授权 / 前台+已授权 / 后台+已拒绝），并把通知的 title+body
拼成一个 payload 去撞三个禁物（消息标记、房间 ID 前 6 位、邀请秘密前 8 位）。每把刀只破坏一个属性，
红的事不同 ⇒ 三个读数各自有牙：

| 刀 | 破坏的东西 | 期望的红 | 实际读数 |
| --- | --- | --- | --- |
| N1a | 把 `location.hash` 前 8 位塞进 body | `clean` 臂 | **绿**（等价变异）：body 只有前缀、秘密是空串 ⇒ 查代码发现 RoomView.tsx:148 在进入房间后已 `history.replaceState` 抹掉 `#` 片段，秘密此刻不在 URL 上 |
| N1b | 把 `JSON.stringify(localStorage)`（= 设备凭据库）前 200 字塞进 body | `clean` 臂 | FAIL：body 里出现 `roomId=…`、`secret=…` ⇒ "通知面出现任何房间材料就红"被证明 |
| N4 | 让 `notifyEncrypted(leaked)` 收正文，调用点传 `e.msg.text` | `clean` 臂 | FAIL：`body="KNIFE-N4:后台-whzmvb-…"`，而 `total=1/1` 未动 ⇒ 规范 §4"不含消息正文"这一句确实有人守 |
| N2 | 摘掉 `if (!document.hidden) return;` | 前台累计计数 | FAIL：前台那次从 1 变 2（后台/未授权两臂不受影响） |
| N3 | 摘掉 `Notification.permission !== 'granted'` | 未授权累计计数 | FAIL：未授权那次从 1 变 2，而**前台仍是 1** ⇒ N2/N3 的签名可分辨，不是同一格 |

工装证人：每把刀都先确认 `npm run build` 退 0、且 `KNIFE-*` 字面串真的出现在 `.next/static/chunks/*.js`
里再跑腿（否则就是"刀没进包 ⇒ 误判成判据没牙"）；N2/N3 这类删语句的刀改用"源文件 grep + 读数自己动"当证人。
N1b 的原始日志含该临时房间的完整秘密，落盘前已按 `[redacted]` 处理（`scratch/knife-n1b.txt`），
那间房在 lane 收尾时已销毁、临时 `DATA_DIR` 已删。

N1a 那一刀本身也是一条结论：**产品已经把邀请秘密从地址栏摘掉了**，通知面拿不到它；
但同一枚刀被用来确认判据"不是恒真"——它必须能红，所以才补 N1b/N4。

## 4. 构建 / 发布 / 部署链的读数

`npm run release`（= `node scripts/build-release.mjs`）：

```
[release] copying the production node_modules closure (60 package trees)
native binary: node_modules/better-sqlite3/build/Release/better_sqlite3.node
static assets: 13 files under .next/static
runtime data: none shipped (DATA_DIR must point at persistent disk)
top level: .next, dist, docs, ecosystem.config.cjs, node_modules, package-lock.json, package.json, public
[release] artifact audit passed
[release] copy:    health ok → home page served → runtime data not published as static content
            → room create + status over HTTP IP:port ok → websocket upgrade ok
            → join proof without the room secret refused (BAD_PROOF)
            → join with the correct proof accepted (slot 1)
            → destroy without the creator token refused (403)
            → creator destroy cleaned the room and its temp attachment dir
            → restart kept ACTIVE room data and did not revive the destroyed room
[release] extract: 以上 10 步在**解压出来的树**上逐条重跑，全部同样通过
[release] tarball: release/poofspace-deploy.tar.gz (91.6 MiB)
```

即规范要求的"必须实际验证解压后的产物可独立启动"是真跑了两遍（暂存副本 + 解压树），
不是只生成了一个目录。`release/build-info.json` 里 `smoke=standalone-production-boot`、
`stagedCopyVerified=true`、`extractedTarballVerified=true`。

## 5. PASS 不等于主张全部成立（与 `docs/DEBT.md` 对齐）

以下句子**没有**被上面的绿覆盖，按"未验/部分验"记账，不当作已完成：

1. 浏览器通知（授权后、后台时触发、内容不含正文/文件名）：**有判据并已四把刀验过**（`browser notification content`，§3.1），
   但那条腿用桩替换 `window.Notification`，所以"用户真的在浏览器弹窗里点了允许"与"操作系统真的弹出那条通知"两半仍未覆盖（D3）。
2. "长时间运行无持续增长的队列/内存/临时文件"：只有**有界性**判据，没有跨小时趋势判据（D7）。
3. "100 人"是 Node 侧真 WS 客户端，不是 100 个真浏览器标签；广播数字是同机下界（D6）。
4. 生命周期与历史解密用的是同机双 context，不是**物理两台设备**（D5）。
5. CSP 的 `script-src 'unsafe-inline'` 是为 Next App Router 的行内 flight 脚本留的口子，未消除（D1）。
6. CSPRNG 缺失时提示的是工程英文串而不是中文文案（`describe()` 接不到 `encoding.ts` 抛的裸 `Error`）（D4）。
7. B1 标题里的"clean tree"：本轮 B1 跑时 Next 缓存是热的；冷构建（删 `.next`/`dist` 后 `npm run build`）另记在下文第 6 节。
8. "页面在前台不重复系统通知"已由 `browser notification content` 的前台臂守住（撤掉守卫那一刀会红）；
   仍缺的是**"切后台超过 grace 再回前台"能否复用槽位重连**这一条时序（D8）。
9. ~~"销毁后本设备恢复入口消失"这一格还没有判据（D9）~~ —— 已补：真实浏览器腿 `recovery entry disappears after destroy`（两台 context，判渲染出来的卡片），见 §7.5 与 DEBT D9（CLOSED）。
10. "100 人重连抖动在修复后不再出现 `ROOM_FULL`"：红过的三条里，两条来自一条**已修的缺陷**（心跳 grace 只有 1.7 个 ping 周期，
    清扫会摘掉 socket 还开着的成员：改后台面 T4 `FAIL (65.0s)` → 改后 `PASS (64.6s)`，见 §1.1 与 D14），
    第三条（客户端 10 s 定点预约超时）至今只出现过一次、未复现，按 D13 记为量具形状。
    仍**没有**的判据是"真机后台节流 60 s 再回前台能否复用槽位重连"（D8），以及跨小时趋势（D7）。
11. "其他资源上限应通过目标部署环境下的压测校准"：规范只把 20 / 100 / 300 s 三个数定死（这三个有静态判据），
    `MAX_CONNECTIONS_NODE=4000`、`MAX_CONNECTIONS_PER_IP=512`、`TEMP_BYTES_MAX_NODE=20 GiB`、
    `VACUUM_FREELIST_PAGES=4096`、`DESTROY_RETRY_MS=10000` **是我拍的、没在目标机上标定过**（D15）。
    本轮新增的 8/7 两条资源判据只证明"闸门存在且会拒"，不证明"这个数对那台机器合适"。
12. "第 299 秒成功 / 第 301 秒失败"是用**注入时钟**跑的：判决式被验到了，真实节拍没有被验到
    （`tick()` 每 5 秒一次，所以到期检测最坏晚 5 秒，那 1 秒余量是算出来的）（D16）。
13. 残留扫描只在 `DATA_DIR` 这一层：文件系统 journal、页缓存、快照、外部备份与 SSD 磨损均衡映射都不在射程内，
    所以文案停在"不存在可用的应用层恢复路径"，不许升级成"绝对不可恢复"（D17）。
14. 运维通道的能力边界：令牌文件的 `0600` 在 Windows 上是 libuv 近似语义，**同用户其他进程仍可读**；
    反向代理开启 `TRUST_PROXY` 后按 IP 闸门会把所有访客算在代理上（D18）。
15. "释放数据库连接的正确顺序并重新初始化空库"只有 `--offline` 那条路径做到了字面意义（关连接→删
    sqlite/-wal/-shm→重建空库→复读为 0）；在线 `purge-all` 是"清空 + checkpoint + VACUUM + 复用同一连接"，
    **没有**"连接被真正关过又开起来"的证据（D19）。DEPLOYMENT 里因此写明：要彻底重启用 `--offline`。
16. "销毁后本设备的恢复入口消失"已经补成真判据（浏览器线 `recovery entry disappears after destroy`，两台 context），
    §7.5 有它自己那次空枪的记录。仍**没有**判据的是相邻的两格：`UNKNOWN`（服务器连不上）时"入口必须保留并标成待确认"，
    以及成员在真机上被后台节流超过宽限后能否复用槽位重连（D8）。

## 6. 冷构建、最终产物与"包与源码同源"这道闸

**冷构建链**（真实删掉 `.next`、`dist`、`tsconfig.tsbuildinfo` 之后一次性跑完
`npm run release` → `npm run gates` → `npm test`，日志 `scratch/release-cold2.log` / `scratch/gates-cold2.log`）：

- `npm run release` 退 0；`build-info.json`：`builtAt=2026-10-15T04:26:14.710Z`、
  `nextBuildId=8pW8hWKt0f8KJ45wVaGSR`、`sourceNewestMs`/`outputNewestMs` 成对写盘，
  `platform/arch/node/abi=win32/x64/v24.16.0/137`。
- 紧接其后的整条台面：**15 PASS / 0 FAIL / 0 SKIP**（含 B1–B10 与 T1–T5，逐条读数见 §1 的表）。

**"发布包里的服务端就是这棵树编译出来的"（D12）—— 反向证人实跑**（不是推理）：

```
$ touch src/server/service.ts
$ npm run gates -- --only=B2
> B2 artifact carries the production closure, the native sqlite binary and the static assets
  SKIP (0.0s) the tree changed after the artifact was packed
       (src now 2026-10-15T04:35:05.091Z > packed 2026-10-15T04:12:03.687Z); run npm run release

0 passed, 0 failed, 1 skipped
```

即：动过源码之后 B2/B3/B5 一起不认这个包，且**未点名的腿不会出现在报表里**（`0 passed`），
所以 `--only` 过滤跑不会伪造出绿。事故本身（12:17 那次把 12:09 的旧 `dist` 打进包、
12:11 的存活修复没进产物而所有 smoke 步全绿）与闸门实现见 `docs/DEBT.md` D12、`docs/DEPLOYMENT.md`。

证人打完之后重新 `npm run release`，让**交付的那一包**就是被闸门认过的树；
下面这一行是交付产物的最终读数（重新打包 + 重新整条台面）：

交付产物（`release/poofspace/` + `release/poofspace-deploy.tar.gz`，91.6 MiB）在 D14 那一刀之后**重新打包并重跑整条台面**：
`REL_EXIT=0` → `GATES_EXIT=0`、**15 PASS / 0 FAIL / 0 SKIP**；`build-info.json` 记 `builtAt=2026-10-15T04:49:38.807Z`、
`nextBuildId=vDi6U-douAI-7VtkLR-J-`、`stagedCopyVerified=true`、`extractedTarballVerified=true`、
`win32/x64/node v24.16.0/abi 137`、60 个生产包 + `better_sqlite3.node` + 13 个静态文件、产物内运行数据 none。
也就是说 §1 的那张表就是**这一包**的读数，不是更早那包的；中间那一遍 T4 红（`gates-final3.log`）已修并在这包里复绿。

## 7. 补充规范这一轮：治理判据、它们各自的刀、以及一次真缺陷的前后对照

补充规范《临时数据、房间销毁、容量限制与服务器管理》把自己排在旧规范之前（"冲突时以本规范为准"），
所以这一轮改掉的**是已经认证过的行为**：15 秒空房窗口 → 300 秒 `IDLE_GRACE`；销毁留墓碑 → 销毁不留任何记录；
公开 `/api/health` 带房间计数 → 只答活性；`/api/rooms/<id>/status` 答在线数 → 答一位"还能不能进"。
下面每个读数都是这台机器上跑出来的原文（台面 `scratch/gates-spec8-2.log`、全量 `scratch/vitest-spec8-*.log`、
打包 `scratch/release-spec8*.log`、刀账 `scratch/mutation-ledger-spec8.md`）。

### 7.1 §8 三族判据落在哪一格

| 规范条 | 判据（测试名） | 关键读数 |
| --- | --- | --- |
| 一.1–8 生命周期 | `tests/lifecycle/idle-grace.test.ts` 第 1–8 条 + `lifecycle.test.ts` 的 idle-grace 一族 | 最后一人离开即刻 `IDLE_GRACE` 且密文原样；`tick(t0+299_000)` 后重进回到 `ACTIVE`、`empty_since` 归 NULL、`history.msgs` 仍是 `[1]`（同一间房）；`tick(t0+300_001)` 后同房邀请 `ROOM_NOT_FOUND`；真实 WS 断线（刷新形状）不销毁、重进读到原文；`DESTROYING` 之后请求/刷新/重启三扇门都进不去（签名 `ROOM_DESTROYING`）；宕机期间过期的房间在 `recoverOnStartup` 里被完成清理；销毁 A 不动 B |
| 二.1–7 严禁长期保存 | `tests/storage/hygiene.test.ts` 第 1–10 条 | 销毁后 `rooms/messages/attachments/attachment_chunks/slots/session_tokens` 全为 0；`retentionPurge` 这个符号**不存在**（`expect('retentionPurge' in service).toBe(false)`）；表名单双向差集恰好是那 7 张运行时表（无审计/目录/索引/备份表）；`DATA_DIR` 里除 sqlite(+wal/shm)、`rooms/`、`admin-control.json` 之外没有第三个文件 |
| 二.日志 / 三.不可枚举 | `the log stream never carries a room id…`、`serves a liveness-only health document…`、`answers a room status probe with one joinability bit…` | 日志臂**故意走一遍失败分支**（把 `removeRoom` 打成抛错再销毁），抓到的正是那条路径会带的 `rooms/<id>` 路径串；health 用 `/rooms|online|messages|attachments|connections|uptime/` 反着判；`/status` 用 `toEqual({joinable:true})` 钉成"精确形状"，多一个字段就红 |
| 三.存储清理超出 `DELETE` | `4.`（残留扫描）、`4b.`（pragma）、`10.`（重试不是宣告） | 把整个 `DATA_DIR` 按字节读一遍找旧密文：清理后 `[]`，`secure_delete=OFF` 时命中 `poofspace.sqlite`；`VACUUM` 后连 `-wal` 也不留；`removeRoom` 抛错的房间保持 `DESTROYING`（`slotsHeld=1`）且密文仍可扫到，重试成功后两处都归零 |
| 四.容量与资源 | `tests/capacity/room-capacity.test.ts` 第 1–9 条 | `MAX_ROOMS=20` 是出厂值；9 路并发创建在 `maxRooms=5` 上恰好 5×201 + 4×503、库里 5 行；`ACTIVE/IDLE_GRACE/DESTROYING` 三态都算名额；拒绝文案 `暂时无法创建新房间，请稍后再试` **不含数字**；启动校验对 `MAX_ROOMS=0|many|100000`、`ROOM_IDLE_TTL_SECONDS=5`、`MAX_PARTICIPANTS_PER_ROOM=501` 一律抛错并点名变量；每人 8 份未完成上传额度、节点 20 GiB 临时额度、连接闸门两道各有自己的刀 |
| 五/六 运维命令 | `tests/admin/admin-commands.test.ts` 第 1–9 条 | 公共端口四条候选路由全 404；无令牌/错令牌 401；`status` 读数不含房间 ID 也不含邀请码；`disconnect-all` 后 `rooms=1 unfinished=0`、连接归 0、旧链接被拒且客户端**只拨一次号**（`dials=1`）就停；`purge-all` 无 `--yes` 时退 2 且不动数据；带确认时六张表全 0、`rooms/` 空、`-wal` 长度 0；`removeRoom` 失败时保持维护态（`isPaused=true`）且**同一条命令重跑能补完并 resume**；服务在跑时 `--offline` 拒绝删库（退 1），停机后离线清理成功 |

`T6` 这条腿还多做一件台面自己的事：把 `tests/` 磁盘上的测试文件和 `LANES` 名单做**双向差集**，
任何一个目录没人认领就 FAIL——防止"新写了一格判据但没有任何台面跑它"这种最常见的失效方式。

### 7.2 交付包里的运维命令是真跑过的（B4）

上一轮 B4 只验 PM2 生命周期。这一轮把**产物里的** `npm run admin:rooms:disconnect-all -- --yes`
放进 B4，跑在 PM2 拉起的打包服务上，读数：`exit=0 cleaned=true effect=true`，
命令自己印出 `rooms=1 unfinished=0 resumed=true paused=false`，随后台面再用 HTTP 复核那间房的
`joinable=false`——即"退出码之外，效果被独立验过"。这条 `effect=` 断言是这一轮新加的调用边证人。

### 7.3 判据自己的刀（本轮 24 把）

完整台账在 `scratch/mutation-ledger-spec8.md`，摘几把最能说明"这不是空枪"的：

| 刀 | 期望红 | 实际读数 |
| --- | --- | --- |
| `roomIdleTtlSeconds 300→240` | 静态数 + 299 s 那格 | `expected 240 to be 300`；`2. rejoining at 299 s` → `expected 'UNKNOWN' to be 'IDLE_GRACE'` |
| join 不再认 `IDLE_GRACE` | 窗口内回房一族 | 5 条红，签名一律 `join failed: ROOM_DESTROYED`，含真实 WS 那条 |
| `createRoom` 的名额检查摘掉 | 计数/并发/措辞 | 并发那格读到 `expected [201×9] to have a length of 5 but got 9` |
| 销毁末尾改回写墓碑 | "销毁=没有记录"整族 | 13 条一起红 |
| `secure_delete ON→OFF` | 残留扫描 + pragma | `expected ['poofspace.sqlite'] to deeply equal []` 与 `expected +0 to be 1` 两格各自红 |
| `/status` 多答 `online` | 精确形状 | `expected {joinable:true, online:1} to deeply equal {joinable:true}` |
| 只摘**按 IP** 那道闸门 | 两道闸门各自的牙 | 第二例红 `{"connectionsPerIpMax":2}: expected false to be true`，第一例**保持绿** |
| 容量提示里塞 `1/1` | 不泄露内部状态 | `expected '房间已满（1/1），请稍后再试' not to match /\d/` |
| 控制通道不校验令牌 | 令牌面 | `expected 200 to be 401` |
| 清理失败也 `resume()` | 失败保持维护态 | disconnect-all 与 purge-all 是**两格**（`7.` 与 storage `8.`），各自只红自己那格 |

**一把没切动的刀，本身就是一条结论**：把 `join:err` 的终结码处理摘掉之后，
`disconnect-all…旧链接不能恢复` 那条腿**没有红**——因为它读的 `status==='destroyed'` 是
`room:destroyed` 帧设置的，跟终结码这条边无关（等价变异）。于是补了一条按"拨号次数"下判的
`4b.`（把 `openSocket` 包一层计数），重下同一把刀立刻红：`expected 6 to be 1`——
3 秒里旧客户端对着已不存在的房间拨了 6 次。这条同时也说明那个修不是洁癖：没有它，
被 `disconnect-all` 踢掉的浏览器标签会形成真实的连接风暴。

**同批新加的判据不算本批的证人**（D14 立的规矩，这一轮继续照办）：§7.3 这些红只证明新格子有牙；
本批**产品改动**的证人是 §7.4 那对全量前后读数与 §1 的台面。

### 7.4 一次真缺陷：静默成员的保席只认应用层 ping（前后对照）

改前全量并发跑（`scratch/vitest-spec8-1.log`）：`7 failed / 144 passed`，红的整文件是
`tests/perf/stress.test.ts`，签名不是"0 files 0 tests"的 worker 崩，而是**台账本身**——
99 个客户端都 `join:ok` 了，库里 `slots WHERE connected=1` 只剩 3（`expected 3 to be 100`）。

顺着签名查下去，找到两条都在"把活着的人判死"的边：

1. `startPingLoop()` 里算出来的 `cutoff` 被 `void cutoff` 丢掉，判决实际是"**一轮 pong 没回就 terminate**"，
   跟文档里承诺的 60 秒宽限无关；
2. 槽位台账 `slots.last_seen` 只由**应用层** `ping` 帧刷新（客户端 15 秒一发），
   网络层的 protocol pong 完全不参与——页面定时器被节流/饿着时，socket 还开着、连接还活着，
   但席位已经没了。

改法：宽限按时间判（`now - lastPongAt > heartbeatGraceMs` 才收），并把 pong 当作**活着的证据**
回灌 `service.heartbeat()`；任何 inbound 帧同样刷新席位。顺手删掉了写而不读的 `conn.alive`。

| 读数 | 改前 | 改后 |
| --- | --- | --- |
| 全量并发（14 文件） | `7 failed / 144 passed`，172.6 s | `152 passed / 0 failed`，85.1 s（`vitest-spec8-2.log`） |
| 补完新格子之后 | — | `156 passed / 0 failed`，85.5 s（`vitest-spec8-3.log`） |
| 台面 T4（串行两文件） | 上一轮 FAIL→PASS 之后本轮再没红 | `PASS (58.7s) 2 files, 9 tests` |
| 新格子的牙（W1：摘掉 `pong → heartbeat`） | — | 只有 `keeps an idle member alive through the protocol pong` 红（`expected 2 to be +0`），隔壁"靠业务帧续命"那格**保持绿** ⇒ 两条边各自有独立证人 |

这条缺陷的形态与 D14（grace 只有 1.7 个 ping 周期）同源，但**不是同一个修法能覆盖的**：
D14 调的是常量比例，这一条调的是"谁有资格续席"。它同时也回答了 D13 里那个一直没复现的
"10 秒上传预约超时"——那一红就是同一个席位被饿掉之后的级联，本轮两次全量并发都没再出现。
D13/D11 仍按 PARTIAL 记账：设备级的后台节流时序（D8）到今天还是没有真判据。

### 7.5 浏览器线新增的两条腿，以及它们查出来的一处虚假保证

这一轮把规范里"销毁后本机恢复入口消失"与"锁形提示不作虚假保证"两句补成了真判据，
顺带抓出一个**只在服务端字节里**的问题。

**`recovery entry disappears after destroy`（D9）**：A 建房并销毁，B 是另一台 context —— 它只通过邀请链接进过房，
从不点销毁，本地秘密完好。判据打在渲染出来的卡片上：`before` 必须为 1（控制臂，否则"消失"什么也没证明）、
`after` 必须为 0，并且同一读数里服务器要独立确认 `joinable=false`、B 的凭据库里确实没有这一条。
第一版这条腿是**空枪**：它让同一台设备自己建房自己销毁，入口是被"秘密已失效"的 catch 分支清掉的，
把探针分支的删除摘掉照样绿。改成两台 context 后，同一把刀立刻红：
`FAIL … before=1 after=1; server said not-joinable=true; vault entry left=true; states=暂时无法校验`
（`scratch/mut-d9-knife2.log`），撤刀重建后 `before=1 after=0`（`scratch/d9-leg-revert-check.log`）。

**`served html makes no transport assurance`（§六的锁形提示）**：起因是 9 腿整跑里 `http lock tooltip` **红过一次**：
`tooltip was "…当前连接使用 HTTPS。" on a page where secure=false`；单跑该腿绿，整跑第二遍也绿。
没有归到"仪器抖动"，往下量：`RoomView` 里 `const secure = typeof window !== 'undefined' ? protocol==='https:' : true`
—— 服务端渲染时猜 `true`，而 `.sec-tip` 文案**在首屏 DOM 里**。直接对旧产物发一个明文 HTTP 请求验证：
**返回的 HTML 字节里含"当前连接使用 HTTPS。"**（旧代码）。也就是说浏览器在 hydration 之前拿到的就是假保证，
那条腿恰好抓到过一次；而"读 hydration 之后的 DOM"这种判据层次抓不到（我先加的正是这种，刀下不去）。

处置：`secure` 改成 `useState(false)` + `useEffect` 里按 `location.protocol` 纠正 —— 服务器永远写保守文案，
客户端挂载后再补上（宁可一瞬间少说）；判据搬到**服务端字节**层（新腿），并对旧代码重下同一把刀：

```
FAIL served html makes no transport assurance: status=200; tooltip present in first paint=true;
     https claim in served bytes=true; http-warning copy present=false     ← 旧那行（scratch/assure-knife.log）
PASS served html makes no transport assurance: claim=false conservative=true ← 修后（scratch/assure-green2.log）
```

十腿整跑复绿：`LANE_EXIT=0`，20 行 PASS、0 行 FAIL（`scratch/lane-10legs.log`）。
这条经验（判据要选对层次、换层次后重下同一把刀；SSR 猜值要往"少说"猜）已写进记忆与 §3 的口径。

### 7.6 这一轮的产物与状态

开源发布这一轮的链条（补上 D9 浏览器腿、修掉服务端 HTML 里的虚假保证、加 LICENSE/README/CHANGELOG/CONTRIBUTING/SECURITY 与 CI floor）：

1. `npm run release` → `REL_EXIT=0`。产物顶层清单现在是
   `.next, CHANGELOG.md, LICENSE, README.md, README.zh-CN.md, dist, docs, ecosystem.config.cjs, node_modules, package-lock.json, package.json, public`
   —— 审计把 `LICENSE / README.md / docs/DEPLOYMENT.md` 列为**必须随包**，缺一个就 FAIL。
2. 整台面第一次（`scratch/gates-oss-final.log`）：**13 PASS / 3 FAIL / 0 SKIP**，`GATES_EXIT=1`。
   三条红（B6、B10、T5）**全部来自同一条腿**：`https lock tooltip` 在 TLS 那台节点上建房时
   `page.waitForSelector: Timeout 30000ms exceeded`。单跑该腿绿（`scratch/diag-https-tooltip.log`），
   浏览器线独立整跑两遍绿（10 条腿，`LANE_EXIT=0`）。
3. 同一个包重跑整台面（`scratch/gates-oss-final2.log`）：**16 PASS / 0 FAIL / 0 SKIP**，`GATES_EXIT=0` —— 即 §1 那张表。

**那一次红没有被"第二次绿"抹掉**：它登记为 D20（未复现的间歇红，签名明确、只此一条腿、
两次台面一次见到），处置口径与 D13 相同 —— 不升格成产品缺陷，也不许调大超时把签名消音。

交付包：`release/poofspace/` + `release/poofspace-deploy.tar.gz`（final2 那一次 96,096,390 字节 —— 这个数字
不钉死，交付那次"只重拷文档"的打包会让它跟着文档的字节数走，要以包外实际文件为准）；
`build-info.json` 记 `builtAt=2026-10-15T08:20:02.497Z`、`nextBuildId=SYQv27QbLjMho6dSA1zuX`、
`stagedCopyVerified=true`、`extractedTarballVerified=true`、`win32/x64/node v24.16.0/abi 137`、
60 个生产包 + `better_sqlite3.node` + 13 个静态文件、产物内运行数据 none。
逐腿读数（final2 那一遍）：B1 13.4 s、B4 11.6 s（`shipped admin disconnect-all exit=0 cleaned=true effect=true`）、
B8 约 14 s（6 文件 55 条）、T1 6.8 s（3/62）、T2 2.7 s（2/25）、T3 12.8 s（4/30）、
T4 71.6 s（2/9）、T5 十条腿全绿、T6 8.6 s（3/30）。
全量 vitest（撤刀之后独立复跑）：14 文件 / **156 条全绿**，`VITEST_EXIT=0`，85.5 s（`scratch/vitest-spec8-3.log`）。
变异证人合计 24 + 3 把（D9 的两把与 SSR 保证那把见 §7.5），台账 `scratch/mutation-ledger-spec8.md`。

一句要如实说的：包里那份 `docs/*` 就是本节这一版文字，而它引用的台面读数来自紧接其前的那一次整台面跑；
两者对应的**代码树完全相同**，差别只在逐腿耗时那一列。

但**交付包里的编译产物不是上面那条 08:20:02.497Z 那一次 build 的字节**：台面 B1 那条腿自己会从干净树跑
`npm run build`（`scripts/run-gates.mjs:203`），final2 那一遍因此在 08:27:39Z 重写了 `.next/` 与 `dist/`，
而 Next 每次编译换一个随机 `BUILD_ID` —— 交付包里记的是 `nextBuildId=Bl3dissujagYIdmWjbGB2`。
两份记录的源码戳是同一个 `2026-10-15T08:09:29.269Z`（`sourceStamp()` 只算 `src/` 与配置文件，文档不进这个戳，
所以"只重拷文档"的打包不会被判定为过期），也就是说：**同一份代码，编译了两次**，台面认证的是第一次，
交付的是第二次。要分辨这两者只能靠包内 `build-info.json`，正文不写交付那一次的 `builtAt` ——
每改一次文档就要重打包一次，把 `builtAt` 写进正文等于让这句话在自己脚下过期。
交付用的打包走 `npm run release -- --no-build`：产物比源码旧就直接拒绝（`scripts/build-release.mjs:138`），
两条启动冒烟照样重跑 —— 最近这一次退 0，暂存树与解开的 tarball 各 10 条断言全过
（`scratch/release-docs-final.log`）。

版本状态：本轮经用户明确授权后在本地建立 `chore → feat → test → docs` 四条主提交，其后是把本段状态与
"认证的那次编译 vs 交付的那次编译"写回报告的若干条 `docs` 提交，注解标签 `v1.0.0` 打在最后一条提交上（每条都用显式路径 `git add`，索引里不含 `data/`、`release/`、`scratch/`、日志或数据库文件）。
**建仓与推送仍留给执行人**（他选的是"只做本地 commit + tag"）；命令见 `CONTRIBUTING.md` 的
"Publishing to GitHub"，其中 `package.json` 的 `repository`/`homepage`/`bugs` 三格要由所有者填自己的公开地址，
本报告与脚本都不替他猜 URL。
本报告之前各轮所写的"未提交、未打标签"是当时的状态，不是现在的。

### 7.7 用户手测出来的五条界面缺陷，与 dev 现场的三条（2026-10-15 晚，第三轮）

这一轮的输入全部是"我自己点出来的"，不是规范里的一句话，所以每条的判据都打在**渲染后的东西**上，
台账逐刀记在 `scratch/mutation-ledger-spec8.md` 的"追加"与"追加二"两节。

浏览器线从 10 条腿涨到 16 条（+TLS 那一格共 16 行读数）。新增六条：

| 腿 | 它到底在读什么 | 各自的刀（红相） |
| --- | --- | --- |
| `first run names the device and identity reaches peers` | 没缓存昵称时建房/进房会被拦住、给的名字可换、只有确认过那一次才写缓存；对端看到的作者标签是从渲染后的 `.author` 读的；自己那一行既无头像也无名字且比对端矮 | K1 门禁放行未确认的名字 ⇒ `roomIdBefore=1`；K2b join 用兜底名 ⇒ `author label seen by peer="我"`；K3 自己那行重新带头像+名字 ⇒ `own av=1 author=1 h=92.3 vs peer 92.3` |
| `an uploaded image reaches the other device` | 真让浏览器画一张 PNG 上传，再看**对方**那一行：`img.thumb` 恰好 1 个、`naturalWidth>0`、占位框 0 个 | K4 摘掉 `metaFor`（回到死入口）⇒ 腿在"对端一直没渲染出图"那一步抛错；K5 外层占位框不再随 meta 收起 ⇒ `placeholders 1` |
| `joined rooms appear as history on the home page` | 加入过、且没销毁的房间在这台设备的首页列表里，标题就叫"历史" | K6a 标题不改 ⇒ 该腿红（第一趟驱动只留了判决行，逐字读数没留档）；K6b 整段不渲染 ⇒ 腿在等 `.section-title` 时抛错 |
| `destroying leaves the room and returns home` | 房主与成员两边的 `location.pathname` 都得是 `/`，并由服务端确认这个房间不再可进 | K8 摘掉 `destroyed` 事件里的返回 ⇒ 成员留在死房里 |
| `recovery entry disappears after destroy`（改写） | 换到 loopback 直读服务端：房主销毁后，**另一台设备**那张卡片消失、本机 vault 里也不留 | —（改的是量具：`poof.insecure` 这个主机名只存在于 chromium 的 host-resolver 规则里，Node 侧的 `http.get` 永远连不上） |
| `pinned list holds on incoming`（换形） | 钉在底部的列表，来消息时只能**朝前**走：`travel === sizer 增量`、`reversals 0`、离底距离 0，单条到达时 sizer 恰增长那一行实测高度 | J1 观察器用第一次渲染的 `heights` 建 map ⇒ `reversals 1`、`sizer +84`（正是要估计值的坑）；J1b 无变化的那一支交回旧 map ⇒ `sizer +−8px`；J2 摘掉钉底那一行 ⇒ 热身阶段就等不到 |

三条 dev 侧：`npm run dev` 点了没反应（服务端把非 `/ws` 的 upgrade 一律 `socket.destroy()`，
Next 的 dev HMR socket 死在半路 ⇒ 页面渲染了但一次事件都没接上；D21 登记、已实测对照），
dev 控制台那条 `eval()` 报错（CSP 只在 `NODE_ENV=development` 那一支放行 `'unsafe-eval'`，
生产串一个字没动；判据把"dev 有 / 生产无 / 未设 NODE_ENV 也无"三格一起钉住），
以及 `/favicon.ico` 404（D24，OPEN）。

两处**没证到**的，写在这里不当已通过：

1. `ownRowIsTighter`（自己那行更矮）只被 K3 那一把刀顺带抓住，没有独立变异 —— 把间距改回去两边一起长，
   比较式翻转不了。
2. 房主自己销毁时那句 `window.location.assign('/')` 实测不是绑定路径（K7 绿）：真正兑现"销毁后离开"的是
   `destroyed` 事件那一臂。那句留着是因为 `client.close()` 与通知到达的先后不保证，但这条腿分辨不出它有没有生效。

压力线这一轮单独立了两条账（D25 独占机器、D26 `pool: 'forks'` 下子进程静默死掉），并把
`npm test` 拆成"除 `tests/perf`"+"`tests/perf`"两次调用。同时给测试台架的 **connect 这一条边**加了重试：
`reconnect churn` 的两种红相（`ROOM_FULL` 与 `socket error`）里，后者发生在台账 `{"rows":80,"online":80}` 的时刻
—— 座位空着、是操作系统拒了握手。重试只认连接类失败，`ROOM_FULL` 一律不重试；这条边的牙重新下过一遍：
把 `service.ts` 的容量判据改成"见人就拒"之后压力线立刻红（`scratch/pf-knife.log`，读数含 `ROOM_FULL`），
撤刀后 `stress.test.ts` 单跑 3/3 绿、`tests/perf` 两文件 2/2 绿。

分支模型也变了（不是我改的代码内容）：`main` 现在是公开线，不含 `Dockerfile` / `.gitlab-ci.yml` /
`docker/` / `k8s/` / `docs/DEPLOY-K3S.md`；公司运行配置在 `internal-deploy` 上、只推 `lc`。
判据是 `git ls-tree -r --name-only main | grep -cE '^(Dockerfile|\.dockerignore|\.gitlab-ci\.yml|docker/|k8s/|docs/DEPLOY-K3S\.md)'`
＝ `0`（本轮实测为 0）。

### 7.8 v1.0.1 的包与状态

- 包：最后一次 `npm run release`（`--no-build`，直接复用台面 B1 那条腿刚构建出来的产物）→ `REL_EXIT=0`，
  `release/build-info.json` 记 `builtAt=2026-10-16T01:02:58.355Z`、`nextBuildId=t8QanNQCCGs-9S4dhY9Fn`，
  暂存树与解开的 tar 包**两边都启动验证过**（各自跑完 10 步冒烟）。
  这一版**不需要**§7.6 那条"认证的那次编译 vs 交付的那次编译"的分开说：16/0/0 那一遍台面的 B1 腿自己重建了
  `.next/` 与 `dist/`，随后的 `--no-build` 打包复用的正是它，所以被认证的那次编译就是交付包里的字节。
  （代价：交付包里的 `docs/` 比仓库最后一条提交早一个提交——那一提交只改文档文字，代码树相同。）
- 判定：`scratch/certify-v101c.log` = **16 PASS / 0 FAIL / 0 SKIP**（同一棵代码树今天另有一遍 16/0/0，
  中间七遍至少红一条，见 §0 的分布与 D26/D27）。
- 版本：`package.json` 升到 `1.0.1`，注解标签 `v1.0.1` 打在本轮最后一条提交上；
  **公开的 `v1.0.0` 标签不动**（它已经指向 `e1958a5`），也不重写已公开的历史。
- Word 版文档从公开线里去掉（`docs/*.docx` 改成由 `node scripts/md-to-docx.mjs <文件…>` 现生成的交付物，
  不再进 git）；口径写进 `.gitignore` 那一格，含"main→internal-deploy 合并会把公司线上这几个 .docx 一并删掉"
  这一条后果。
- 建仓与推送仍归执行人：本轮只在本地提交、打标签。


### 7.9 用户手测出来的八条（2026-10-16 下午，第四轮）

八条要求全部来自"用了一遍界面"的现场，不是规范。逐条给读数，逐条下刀。

| 要求 | 现场是什么问题 | 修完之后（浏览器线读数） | 刀（把它改回坏样子，该腿必须红） |
| --- | --- | --- | --- |
| 文件卡片样式坏了 | 图标没有任何尺寸规则：flex 行里带 viewBox 的 SVG 会吃掉整个容器宽度 | `card 467x40 overflow 0px; icon 32x32; text column 327px; name 327px; size "1.3 KB" 17px tall; button inside=true` | 删掉 `.file .icon` 的 width/height ⇒ `icon 403x403; text column 0px; name 0px; size 84px tall; button inside=false` ⇒ 红 |
| 全局粘贴：剪贴板里的图片与文件都要发得出去 | 只有光标在输入框里时才粘得动 | 无焦点粘贴 3 项（两张异色 PNG + 一个 txt）⇒ `rendered img 2 decoded 2 colours ["#3266cc","#cc3467"] distinct=true, file cards 1 named ["剪贴板里的文件.txt"], queue left []` | 在处理器开头加 `if (document.activeElement?.tagName !== 'TEXTAREA') return;` ⇒ `page {"on":"room","msgs":0,"queue":"empty"}`（什么都没排进去）⇒ 红 |
| 支持多文件发送 | **真缺陷**：串行上传把锁在 `.finally()` 里释放，而 React 这次 render 排在同一条微任务链更早的位置 ⇒ effect 再查队列时锁还拿着，第二项永远等待 | 同一粘贴腿：三项全发出去、队列清空；文件卡那条腿另加一发 —— 选择框**一次选两个** ⇒ `picker sent 2, cards on screen 2, queue left 0`（两个入口共用同一条队列，所以两边都要有证人；判据钉在"屏上有两张卡"，不是 input 的 `multiple` 属性） | 把释放改回 `.finally()` ⇒ `page.waitForFunction: Timeout 45000ms exceeded; page {"imgs":1,"cards":0,"queue":"排队中 剪贴板里的文件.txt 0/1块"}` ⇒ 红 |
| 长文本"展开全文"弹窗过长要能滚 | 弹窗跟着气泡一起把整行撑高 ⇒ 行被重排、窗口移动、渲染该行的组件被卸载，弹窗跟着消失 | `box 5.1x taller than itself; modal 559px in a 720px viewport; buttons inside=true; scrolled to end=true` | 让气泡在弹窗打开时也展开（`body = long && !full ? excerpt : text`）⇒ `Cannot read properties of null (reading 'closest')`（`.scroll-box` 随那一行一起没了）⇒ 红 |
| 气泡还要更紧凑、视觉统一、要原生感 | 行高/气泡内边距/字号各自为政；头尾两块没有材质层次 | 行 `padding 2px 0`、气泡 `5px 10px / r16 / lh1.4`、头像 26px、时间与时间戳 `tabular-nums`；头部与输入条 `backdrop-filter: saturate(180%) blur(20px)` + 一条发丝线；按压 `scale(0.97)`；滚动条改为 overlay（`width:10px` + `background-clip:content-box` 的 3px 透明边框） | 见下面"复制键"那一刀（同一族的紧凑/命中区一起判） |
| 按钮文字视觉不居中 | 给了 `min-height`/`padding` 却没给居中盒；`.link-btn` 是个 `min-height:44px` 的行内 `<a>`，字沉在顶部 | `send dy 0px (h44), expand -0.5px (h32), avatar -0.5px (h28), hover chip -0.5px (h22); home 创建聊天室 0 / 加入聊天室 0 / 恢复进入 -0.5` ⇒ 7 个控件最差 **0.5px** | 把居中那一组的 `align-items:center` 改成 `flex-start` ⇒ `send -15px, expand -9.5px, hoverChip -5px`（头像仍 -0.5，因为它走的是另一条 `display:grid; place-items:center`）⇒ 红。首页那颗在改之前实测 **-12px**，这条就是它掉下来的 |
| 名字 hover 那枚样式视觉不居中 | 同上，且药丸本身太重（描边 + 实色） | 药丸降成一条灰字（`border-color:transparent; color:var(--mute); font-size:11px`），悬停才给 `var(--hover)` 底；`dy -0.5px` | 同上一刀；另外把药丸改回描边实色会让"视觉弱化"这条主张回到旧样子，但没有可量判据 —— 见本节末"没被认证的两条" |
| 复制键太突兀，视觉弱化 | 每行都有一颗带边框的实心按钮 | `pill=22x40px`（可见）而命中区 `band=44x45px`；`reach {up:22, down:0, left:3, right:2}` | 把 `inset: -22px -3px 0 -3px` 收成 `-8px` ⇒ `band=30x45px` ⇒ 红 |

向上滚历史会向下弹（这条最费工夫，三个阶段都有读数）：

1. **先证明现场能复现**。原来那条腿是"我自己在房间里发 60 条，然后往上滚"，量不到用户说的现象；真正的现场是**迟到的新成员**：第一页只有 50 条，往上滚到顶会 `loadOlder()` 追加一整页。改成像用户那样（另一台设备先把 101 条历史写完，这台再点邀请链接进来），并且把"读到第 70ms 再取基准"改成**与手势同一个 task 里取基准** —— 前者把漂移烘进基准，于是修没修都读 0px。
2. **浏览器也是一个执行者**。开着 Chromium 自带的 scroll anchoring 时，这条腿**无论有没有应用自己的保持都读 0px**（两遍实测），也就是假绿。`.list` 现在写 `overflow-anchor: none`，让滚动位置只有一个主人；这条腿才第一次读出差别。
3. **三个阶段各自的读数**（同一条腿，101 条房间，14 步 × 260px）：
   - 保持那一支整个摘掉：稳态每步 `-12 ~ -16px`，**整页历史落地那一步 `+4000px`、下一步 `-4118px`**，净位移 `-704px`（向上滚结果页面往下跑 = 用户说的"向下弹"）。
   - 只补上"保持点按活着的 `scrollTop` 取，而不是按 React 状态取"：稳态 `0px`，但落地那步还差 `260px`，而且**下一步仍粘在 -260px**（保持把刚发生的一次滚轮当成误差纠回去了）。
   - 再把纠正改成 `offsets[index] + dy + (本次 scrollTop - 取保持时 scrollTop)`：稳态 **0px / 13 步**，落地那一步 **260px / 1 步**，下一步 `0px`（不再粘住）。这就是现在绿着的形状。
   - 剩下的 260px（恰好一个滚轮步长）**没有定罪**，按 `docs/DEBT.md` D28 登记；该腿的阈值现在写的是"稳态 ≤2px、落地步 ≤300px"，两个数都落在"坏样子"与"现样子"之间，不是猜的。要宣称"整页历史落地时纹丝不动"，得先把阈值收到 ≤2px 再跑绿。

没被认证的三条（不许当成已做到）：

- "原生感"与"更精致"是审美判断，能量的只有几何：字号/行高/圆角/命中区/居中偏差都有读数，但**没有一条判据规定它看起来像 macOS**。截图在 `scratch/shots/`（宽 1280×720 与窄 480×900 各三张），我自己看过，结论是几何一致、层次按 token 走；这条主张的可证伪形式仍然欠着。
- 复制键"视觉弱化"只落了"描边去掉、颜色降成 `--mute`、悬停才给底"这个形状，没落判据（比如与气泡正文的对比度差值）。改回描边实色不会让任何一条腿变红。
- 用户那句"**所有电脑**的复制快捷键"只验到了 Windows 上的 chromium。那条腿是在页面里合成一次真
  `DataTransfer` + `ClipboardEvent('paste')`（`scripts/run-browser-tests.mjs:1510`），它证的是"无焦点时每一项都进队列"，
  **不证**操作系统剪贴板在各家的载荷形状；WebKit/Firefox 与 macOS/Linux 真机都没跑过 ⇒ 登记在 `docs/DEBT.md` D30，
  中英 README 也只写"页面任意位置直接粘贴"，不写成"所有电脑都能用"。

台面计数：本轮浏览器线 **21 条腿**（`scratch/lane-21e.log` = 21/21 PASS，exit 0；台面里 T5 用的是同一棵树的 `gates-G`）；`npm test` 除压力线那遍 **12 文件 / 148 条**全绿；刀共 **7 把**，全部按"先证明它会红"下在该腿真正启动的那一层（浏览器线跑的是 `dist/` + `.next/`，所以每把刀之后都重建）。

### 7.10 第四轮的产物、标签，以及"被认证的那次编译"（2026-10-16）

- 判定：`scratch/gates-G.log` = **16 PASS / 0 FAIL / 0 SKIP**，`GATES_EXIT=0`。同一棵树的另外四遍台面
  （`gates-C/D/E/F`）读数是 16/0/0、15/1、15/1、15/1，红的都是 T4 崩，见 §0 与 D26。
- **被认证的那次编译**：台面 B1 那一腿在 15:29 重建了 `dist/` 与 `.next/`（`.next/BUILD_ID=tl6vFQcpRtsH_IQY5mvaC`，
  `abi=137`），T1–T6 跑的就是这一份。而 **15:07 打的那一包**（`release-E.log`）封的是上一次编译
  `nextBuildId=862nnXfdWsmXov2g7JrSB` —— 同一份源码（`find src -type f -newer .next/BUILD_ID` 打空：最新的源文件是 14:49 的
  `RoomView.tsx`），只差 Next 每次编译随机生成的 BUILD_ID。**这一条是我在这次收尾里发现的，不是当时就知道的**：
  台面自己的顺序就是"B1 先重建、B2–B5 再判已在盘上的那一包"，所以同一遍台面里这两个来源本来就可能不是同一次编译。
- **交付的那次打包**：`node scripts/build-release.mjs --no-build` 复用上面那次 15:29 的编译，把 §7.9/§7.10 的文档文字
  拷进包里，于是包里的代码字节 = 被 T1–T6 判过的那一份。这一步会改写 `builtAt` 与 tar 包字节数 —— 这两个读数
  **不在这里钉死**（它们会被下一次重打包改掉），按 §7.6 末的口径分开说。`--no-build` 自带前置断言：源码比产物新就死。
- **包里指向的文档必须也在包里**（这次收尾新加的一判，因为发现 `docs/DEBT.md` 被中英 README、CHANGELOG 与本报告点名，
  `docs/ARCHITECTURE.md` 被中英 README 点名，而打包清单里没有它们 —— 读着说明书去找欠账台账会扑空）：
  `SHIPPED_DOCS` 补上这两份，打包审计增加一条闭包检查 —— 逐份被打包的 markdown 里出现的 `docs/<名>.md`，
  若这个文件在本分支的源码树里存在却没进包，审计直接失败。只在文字里被点名、本分支源码树里根本没有的路径
  （§7.7 末用 `docs/DEPLOY-K3S.md` 写"公开线不含什么"）算叙述，不算指针。
  证人：把 `docs/DEBT.md` 从清单里删掉再跑，审计红四条
  （`README.md / README.zh-CN.md / CHANGELOG.md / docs/TEST-REPORT.md points at docs/DEBT.md, which is not in the artifact`，
  `scratch/release-knife-docs.log`，退出码 1）；装回去之后同一支跑出 `doc references: closed over 8 shipped markdown files`。
  这条判据在 `scripts/build-release.mjs` 里，台面没有任何一腿读它（`grep -rn "build-release" tests/ scripts/run-gates.mjs` 打空），
  所以它的证人是上面这两次打包，不是台面。
- 版本与标签：`package.json` 停在 `1.0.1`，注解标签 `v1.0.1` 移到本轮最后一条提交（它从未推送过，
  移动不重写任何公开历史）；**公开的 `v1.0.0` 不动**，仍指向 `e1958a5`。
- **交付包判完就不再往报告里回填**：把文档同步进包里要用 `--no-build` 重打包，重打包又会改掉
  "判定对象是那一次包"这句话所指的字节 —— 追着自己的尾巴转。所以**最后那遍整台面（判的就是交付出去的那一包）
  的读数记在 `v1.0.1` 的标签注解里**，本报告只留 §0 那两遍（`gates-G` / `gates-H`）。这样回填不会翻案：
  台面没有任何一腿读文档（`grep -n "README\|CHANGELOG\|TEST-REPORT\|DEBT\|SECURITY.md\|docs/" scripts/run-gates.mjs`
  打空，`grep -rn "README\|docs/\|CHANGELOG\|TEST-REPORT" tests/` 同样打空），
  而 B3 那条新鲜度判据只看 `src/` + 配置文件（`scripts/stamp.mjs:36`），实测
  `srcNow == packed == 2026-10-16T06:49:24.782Z`，所以"写完文档再打包"这件事不会把任何一条腿变红。
- Word 交付物：`docs/*.docx` 不进 git（`.gitignore:25`），本机用 `node scripts/md-to-docx.mjs <文件…>` 现生成。
- 建仓与推送仍归执行人：公开线 `git push origin main && git push origin v1.0.1`；
  公司线 `git checkout internal-deploy && git merge main && git push lc internal-deploy`（单向，main 不含公司配置）。
