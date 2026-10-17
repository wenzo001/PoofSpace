# 延迟销毁 + 图片预览缩放 —— 设计（2026-10-16）

状态：**待评审**。本文件不改动任何产品代码；实现要等这份设计被读完并点头之后，经 writing-plans 出计划才开始。

**这份设计要拆成两份实现计划**（自评审时发现的唯一范围问题）：两件事除了"都碰 `RoomView.tsx`"之外没有共享的
正确性依赖，捆在一起做会让"预览缩放"的浏览器判据去等一条生命周期迁移链，纯属互相拖累。

- **计划一 · 延迟销毁**：§2.1、§2.2、§3、§4、§5、§6、§7、§9、§10 的生命周期/存储/治理三张表。
  它自己内部有硬顺序 —— **§2.2 的迁移成链必须与 §3 的加列同批落地**，否则公司线上那座活库拒绝开机。
- **计划二 · 图片预览**：§2.3、§2.4、§8、§10 的浏览器线那张表。
  其中 §8.5（把原图宽高填进 meta）是它的前置，不是可选项 —— 没有尺寸，缩放的首帧适配只能等图 load 完再量。
- 两份计划共用的只有 §9 的文档改动纪律与 §10 的"每条判据各自一刀"。

需求原文来自用户，两件事：

1. 图片预览要支持放大/缩小等预览操作，**可以引入开源组件**。
2. 新功能"延迟销毁"：默认不开启；房主在右上角设置；档位 4 / 8 / 12 / 24 / 36 / 72 小时；
   从"所有人离线"那一刻开始计时；到期自动销毁；期间有人回到房间则该延迟**中断**、恢复正常 5 分钟无人销毁；
   下一次仍要延迟，**必须房主本人重新设置**；房主不再设置时，所有人离开就按 300 秒照常销毁。

---

## 1. 用户在岔口上的决策（逐条记录，实现不许漂）

| # | 岔口 | 拍板 |
| --- | --- | --- |
| 1 | 72 小时的保留窗口与"`IDLE_GRACE` 是有期限的例外、不是持久化"（`docs/SECURITY.md:220`）直接冲突，怎么办 | **按 4–72h 全量做，并修正规范与 README 的措辞** —— 对外宣称跟着实际能力走，不拿 72 小时的实现讲 300 秒的故事 |
| 2 | 一间 72 小时房 = 占节点 15% 名额三天，名额怎么算 | **照占名额，但房主点下"设置"那一刻卡一道**（代价转成一次看得见的拒绝，而不是事后全节点 `ROOM_FULL`） |
| 3 | 延迟窗口期间服务器重启/崩溃，这段时间算不算 | **停机照扣**（与现有 `IDLE_GRACE` 同一条语义，不记 downtime） |
| 4 | 这个状态对谁可见 | **只有房主自己看得见**（成员侧零新协议面；HTTP 状态接口照旧只回 `joinable` 一个 bit，不破坏"不可枚举"那条设计） |
| 5 | 房主在**还有人在线时**设好 8 小时，之后又有人进来，设置还在不在 | **只有已经在倒计时中有人回来才中断**；ACTIVE 期的 join 不动那颗旗子 |
| 6 | 预览用开源组件还是手写 | **引入 PhotoSwipe，包一层薄适配器**，库的 DOM 只出现在一个文件里 |

---

## 2. 设计之前必须先说的四条修正（都是读代码读出来的，不是推的）

这四条如果按第一版设计直接写，会有三条真炸。

### 2.1 到期判定和取消路径**也各有两处**

| 角色 | 位置 |
| --- | --- |
| 到期判定 | `src/server/service.ts:925`（`sweepIdleGrace`） |
| **到期判定** | `src/server/service.ts:1092`（`recoverOnStartup`） |
| 取消倒计时 | `src/server/service.ts:226-231`（join 在 `IDLE_GRACE` 内回房） |
| **取消倒计时** | `src/server/service.ts:895-900`（`cancelEmptyTimer`，被心跳清扫与 `sweepIdleGrace:915-919` 调用） |

只改清扫那一处的后果：房主设了 72 小时，运维一小时后发一次版 ⇒ `recoverOnStartup` 拿全局 300 秒一比，
**所有装了延迟的房间在开机那一刻被销毁**。不报错、不红任何现有判据、只在重启时发生。
只改 join 那一处的后果：走 `cancelEmptyTimer` 回房的成员会退回 ACTIVE，但旗子还留着，
"必须房主重设"这条静默失效。

⇒ 收口成一个唯一的真相来源，两处调用者都必须走它：

```ts
/** 一间房此刻真正适用的窗口：装了延迟就用它，否则用全局默认。
 *  两处到期判定都必须经此，否则重启会拿 300 秒去量一间 72 小时的房。 */
private effectiveIdleTtlMs(room: { idle_delay_ms: number | null }): number
```

两处取消路径各自把 `idle_delay_ms` 清成 `NULL`。

### 2.2 迁移不成链 ⇒ **公司线上那座活库拒绝开机**

`src/server/db.ts:177-185` 只有三种情形：没有行 ⇒ 盖上当前版本；`row === 1` ⇒ 跑 v1→v2；
**其余任何不等于当前版本的值 ⇒ 抛错拒绝开机**。而 `DDL` 建表用的是 `CREATE TABLE IF NOT EXISTS`。

合起来，"加一列、把 `SCHEMA_VERSION` 改成 3"这种写法会两头错：

- **已存在的 v2 库**：表已存在 ⇒ `IF NOT EXISTS` **根本不会加那一列**；且 `row=2 !== 3` ⇒ 直接拒绝开机。
  `db.ts:186-195` 那段注释说明这种拒绝开机在 Windows 上还会把数据目录句柄锁住，运维看到的是权限错误而不是真原因。
- **假如只补了 `ALTER`**：v1 那条分支是 `=== 1` 单独一支，会把 v1 **直接标成 3、跳过新列**；
  之后每次 `UPDATE rooms SET idle_delay_ms = …` 报 `no such column`。

⇒ 迁移必须**成链**，不许各支独立跳号：

```ts
export const SCHEMA_VERSION = 3;
// 构造函数里：
//   无行        → 建表已含新列，盖 3
//   v === 1    → migrateV1toV2(); migrateV2toV3(); 盖 3
//   v === 2    → migrateV2toV3();                   盖 3
//   其他       → 抛错
```

`migrateV2toV3` 用 `ALTER TABLE rooms ADD COLUMN idle_delay_ms INTEGER`（加可空列不需要 v1→v2 那种重建表），
并沿用现成的自检：迁移后 `PRAGMA foreign_key_check` 有孤儿就抛（`db.ts:256-257`）。

### 2.3 B2 的依赖名单是**手抄**的 ⇒ 新依赖没进交付包也不会红

`scripts/run-gates.mjs:251` 的 `expected` 是 `['better-sqlite3','ws','@noble/ciphers','@noble/hashes','next','react','react-dom']`，
判据是单向的 `missing = expected.filter(n => !present.has(n))`。这 7 个正是 `package.json` 里 `dependencies` 的手抄副本。
⇒ 加了 `photoswipe` 之后，**就算它压根没进包，B2 照样 PASS**。

⇒ 改成从事实派生，让它不可能分叉，并自动覆盖新依赖：

```js
const expected = Object.keys(
  JSON.parse(fs.readFileSync(path.join(artifact, 'package.json'), 'utf8')).dependencies ?? {}
);
```

### 2.4 PhotoSwipe 的挂载点是**可选参数**，默认挂哪没证出来

`package/dist/types/photoswipe.d.ts:180` 是 `appendToEl?: HTMLElement`。所以"它自己就往 body 挂"这句
**不能当依据** —— 挂在带 `transform` 的虚拟列表行里，就是上一轮那个"祖先 transform 把 `position: fixed`
和 `z-index` 关进层叠上下文"的坑原地复发（`src/components/Modal.tsx:14-21` 那段注释记着）。

⇒ 适配器**显式传 `appendToEl: document.body`**，把这件事从"赌默认值"变成"写下来的决定"。

顺带一条查下来**不存在**的风险：生产 CSP 本来就带 `style-src 'self' 'unsafe-inline'`（`src/server/config.ts:136`），
库注入样式不会被静默剥掉。

---

## 3. 数据模型

`rooms` 加一列，不新增表（`docs/ARCHITECTURE.md:93` 那句"七张表就是全部"继续成立）：

```sql
ALTER TABLE rooms ADD COLUMN idle_delay_ms INTEGER;   -- NULL = 没设；非 NULL = 房主装填的每房窗口
```

**到期时刻不入库**，永远由 `empty_since + effectiveIdleTtlMs(room)` 现算。
理由：`empty_since` 本来就"写一次"（`enterIdleGrace` 的 UPDATE 带 `AND status='ACTIVE'`，`service.ts:333`），
再存一份 deadline 就是给同一个数字找第二个主人 —— 那是 2.1 那一族的成因。

装填值只接受**白名单**，不接受任意数字：

```ts
export const IDLE_DELAY_CHOICES_MS = [4, 8, 12, 24, 36, 72].map((h) => h * 3_600_000);
```

白名单同时解决一件事：`LIMITS.roomIdleTtlMaxSeconds = 86_400`（`src/lib/constants.ts:36`）是**全局环境变量**的
启动硬顶，24 小时以上本来表达不出来；每房走白名单就不必借用那道闸，也没有"随便填个数"的入口。

---

## 4. 生命周期语义（状态表）

| 事件 | 条件 | 结果 |
| --- | --- | --- |
| 房主设 8h | 房主在房里（房子 ACTIVE） | 只写 `idle_delay_ms`，**不碰状态、不碰 `empty_since`**；旗子处于"待用" |
| 最后一人离开 | `connected.size === 0`（`service.ts:321`） | 现有 `enterIdleGrace` 原样触发；窗口按 `idle_delay_ms ?? 全局 300s` 计 |
| 有人回房 | 房间处于 **`IDLE_GRACE`**（倒计时中） | 中断：回 ACTIVE、`empty_since=NULL`、**`idle_delay_ms=NULL`**（一次性） |
| 有人回房 | 房间处于 **`ACTIVE`**（从未空过） | 旗子**保留**（决策 5） |
| 到期 | `now - empty_since >= effectiveIdleTtlMs` | 走现有 `destroy(id,'idle')` ⇒ `DESTROYING → 清理 → 删行`，一字不改 |
| 服务器重启 | 任何 | 已存在的 `IDLE_GRACE` 保留原 `empty_since` ⇒ **停机照扣**（`service.ts:1083-1095`，不改） |
| 房主不再设 | — | `idle_delay_ms` 为 NULL ⇒ 300 秒照常销毁（需求原文最后一条） |

顺手修一个读数缺陷：`service.ts:337` 那行日志现在打印的是**全局** `windowMs`，
装了延迟的房间会留下一条说谎的日志 ⇒ 改成打这间房实际适用的值。

---

## 5. 名额护卡

- 新增节点级 `MAX_DELAYED_ROOMS`，默认 **5**（= `maxRoomsDefault` 20 的 1/4），启动校验 `0..maxRooms`。
  **设 0 即整条功能关死** —— 公司部署想先不开，改一个环境变量即可。
- 装填时：`COUNT(*) FROM rooms WHERE idle_delay_ms IS NOT NULL AND status <> 'DESTROYING' >= 上限` ⇒ 拒绝。
  文案沿用现有纪律（`ROOM_CAPACITY_FULL` 那条）：**不含数字**，不告诉调用方现在几间占着。
- `slotsHeld()` 与 `SLOT_HOLDING_STATUSES`（`constants.ts:22`）**一字不动** —— 延迟房照样占 1/20，
  这是真的（密文还在盘上），改它要动 30 条已认证的治理判据，不值得。

---

## 6. 鉴权与协议面

- 新端点 `POST /api/rooms/:id/delay`，body `{ creatorToken, idleDelayMs | null }`。秘密只走 body，不进 URL。
- 鉴权复用销毁那条路：与 `rooms.creator_token` 做 `crypto.timingSafeEqual`（`service.ts:696-701`），
  不等 ⇒ `ERR.notCreator`。**不信 `slots.is_creator` 标志位** —— "服务端只认 token"这条纪律在册。
- 成员侧**零新协议面**：`join:ok`、`MemberDto`、`ServerFrame` 都不加字段；
  当前值只经房主自己的读路径回（`GET` 带 creatorToken）。
  HTTP `GET /api/rooms/:id/status` 照旧只回 `{joinable}`（`http-api.ts:154-158`）—— 决策 4 要的就是这个不坏。
- 日志：新端点不得记录 `creatorToken`；沿用现有"日志里不许出现完整邀请链接/秘密"的纪律。

---

## 7. 房主 UI

- 右上角一颗时钟按钮，**只对 `client.isCreator` 渲染**（与现有销毁按钮同一个门，`RoomView.tsx:505-509`）。
- 点开弹窗：`不开启 / 4 / 8 / 12 / 24 / 36 / 72 小时`，当前值高亮；被护卡拒绝时把拒绝显示出来。
- 全部走 token；触摸目标 ≥44pt；不新增颜色字面量。
- 已核对：浏览器线里唯一数按钮的那条腿是 `.composer .icon-btn`（`run-browser-tests.mjs:1969`），
  作用域不含页眉 ⇒ 新增页眉按钮不会踢红既有判据。

---

## 8. 图片预览（PhotoSwipe 薄适配器）

**依赖**：`photoswipe@5.4.4`，MIT，ESM，`dependencies: {}`（零传递依赖，实测自 registry 与包内 `package.json`）。

**已实测成立的能力**（读包内 `dist/photoswipe.esm.js`）：`Escape` 关闭、`ArrowLeft/Right` 前后翻页、
`Tab` 焦点圈、`doubleTap`/`doubleTapAction`、`wheel`/`wheelToZoom`、`zoomLevel`/`initialZoomLevel`。
`loadAndOpen(index, dataSource?, initialPoint?)` 的 `dataSource` **可以直接传数据对象**，不需要 `<a href>` DOM ——
正好适配"按需解密成 blob URL"。

**改动**：

1. 新建 `src/components/ImagePreview.tsx` —— **库的 DOM 与 class 只在这一个文件里被碰到**，
   判据打在我们自己的几何上（打开后缩放比例读数、关闭后回到列表）。
2. 显式 `appendToEl: document.body`（见 2.4）。
3. 替换现有 `.lightbox`（`RoomView.tsx:929-938` + `globals.css:1023-1042`）。
   现状顺带修掉三个真问题：现在**没有** ESC、关闭那颗 ✕ **自己没有 handler**（靠冒泡）、点图片本身也会关闭。
4. 前后翻页顺手解决"每张图片各开各的预览、翻页要回列表点"。
5. **原图宽高填进 meta**：`AttachmentMeta` 本来就有 `width?` / `height?`（`src/lib/crypto/envelope.ts:162-163`），
   但聊天上传那条路（`RoomView.tsx:268`）只传 `{name, mime, size, kind, slice}` —— 宽高**从来没被填过**。
   而 `media.ts:62` 生成缩略图时已经 `createImageBitmap` 读过 `bitmap.width/height`：**原图尺寸就在手上，被扔掉了**。
   补进去是两行，不改协议（字段已在，且随 meta 一起被 AEAD 覆盖）。
   没有它，PhotoSwipe 的初始适配与"双击到 100%"只能在图 load 完之后量 —— 那是我们上一轮刚打过的
   "像素到达那一刻重新量行高"那一族。
6. 交付包：B2 名单改成从事实派生（见 2.3），闭包本身是 `build-release.mjs:157` 从 `package.json` 走出来的，
   不手摘，所以新依赖会自动进包。

---

## 9. 必须同步修改的对外宣称（决策 1 的另一半）

| 文件 | 现在写着 | 改成 |
| --- | --- | --- |
| `docs/SECURITY.md:220` | "`IDLE_GRACE` 里保留密文是有期限的例外，不是持久化：房间空了以后 300 秒内原样保留" | 默认 300 秒的有期限例外；**房主可显式延到最长 72 小时**，且仍需房主逐次装填 |
| `README.md` / `README.zh-CN.md` | 无人即销毁 | 加限定语："无人 **且到期** 即销毁；默认 300 秒，房主可显式延长" |
| `docs/ARCHITECTURE.md:104-119` | 生命周期一节按 300 秒叙述 | 补每房窗口、`effectiveIdleTtlMs` 单一真相来源、v2→v3 迁移成链 |
| `docs/DEPLOYMENT.md:189-190` | 环境变量表 | 加 `MAX_DELAYED_ROOMS`；写明 `ROOM_IDLE_TTL_SECONDS` 的 24h 硬顶只管**全局默认值** |
| `CHANGELOG.md` | — | 新增一条 Added + 一条 Changed |

**不改这几处，功能就是拿 72 小时的实现在讲 300 秒的故事。**

连带一条要更新的旧论证：上一轮"首页人数按本机快照、不轮询"的理由是"从首页联网问人 = 加入 = 取消 300 秒倒计时"
（`docs/TEST-REPORT.md` §7.11）。这条功能上线后那个理由**更强**（加入还会作废房主设的延迟），
实现不用动，但 §7.11 那格要补一句"它现在同时保护两样东西"。

---

## 10. 判据与刀（每条各自一刀，这是本仓库的规矩）

**生命周期线（注入时钟，与 `tests/lifecycle/idle-grace.test.ts` 同形）**

| 判据 | 刀 |
| --- | --- |
| 装填 72h → 空房 → `tick(71:59:59)` 房间仍在 | 把 `effectiveIdleTtlMs` 改成恒返回全局值 ⇒ 红 |
| `tick(72:00:01)` → 销毁 | 同上 |
| 71:59 时有人回房 ⇒ 作废**且** `idle_delay_ms` 归 NULL | 摘掉 join 那处的清零 ⇒ 绿（漏） ⇒ 必须补第二处才红，这本身就是"两处取消"的证人 |
| 作废后再空房 ⇒ 回到 300 秒 | 同上 |
| ACTIVE 期 join ⇒ 旗子保留 | 把取消条件从"IDLE_GRACE 时"改成"任何 join" ⇒ 红 |
| **空房 + 装 72h + 重启** ⇒ 房间仍活、到期时刻不变 | 只改 `sweepIdleGrace` 不改 `recoverOnStartup` ⇒ 红（这一条就是 2.1 的证人） |
| 延迟房仍占名额 | 把它从 `SLOT_HOLDING_STATUSES` 摘掉 ⇒ 治理线红 |

**存储/迁移线**

| 判据 | 刀 |
| --- | --- |
| 用**旧 DDL 建一座 v2 库**并塞进几间房 ⇒ 新代码开它不抛错、`idle_delay_ms` 存在、房间一行不少 | 把 `migrateV2toV3` 从构造函数里摘掉 ⇒ 红（拒绝开机） |
| 造一座 **v1** 库 ⇒ 必须走到 3 且有那一列 | 把 v1 分支写成直接盖 3（跳过链） ⇒ 红 —— 这条是"成链"唯一的证人 |
| 迁移后 `foreign_key_check` 无孤儿 | 沿用现成断言 |

**治理线**

| 判据 | 刀 |
| --- | --- |
| 白名单：5 秒、999 小时、`3`、负数一律拒 | 把校验换成范围判断 ⇒ 绿（漏） ⇒ 白名单必须逐值钉 |
| `MAX_DELAYED_ROOMS` 到顶 ⇒ 第 N+1 次装填被拒且文案不含数字 | 上限改成 `Infinity` ⇒ 红 |
| `MAX_DELAYED_ROOMS=0` ⇒ 整条功能关死 | 删掉 0 的特判 ⇒ 红 |
| 非房主 token ⇒ `notCreator` | 换成比 `is_creator` 标志位 ⇒ 红（且这是纪律本身） |
| **B2 从事实派生**：**把 pack 清单里的 `photoswipe` 去掉**（等价于"声明了但打包器没搬进去"）⇒ B2 必须红并点名它。实测：`missing=photoswipe`、`0 passed, 1 failed` | 现状（手抄单向名单）下这一刀是**绿的** —— 那正是 2.3 要修的没牙。**注意刀的形状**：原写"把 staged 包里 `node_modules/photoswipe` 目录挪走"**打不红 B2** —— B2 审的是"包内 `package.json` 声明 ↔ `build-info.json` 打包时记录的清单"，不是打包之后目录的当前状态（实测挪走目录后仍 `missing=none` 绿）。对一个只进客户端 bundle 的依赖，"目录在不在"本来也不是它运行时的必要条件 |

**浏览器线**

| 判据 | 刀 |
| --- | --- |
| 只有房主看得见那颗页眉按钮（对端 context 断言它不存在） | 去掉 `isCreator` 门 ⇒ 红 |
| 弹窗档位齐全、当前值高亮、触摸目标 ≥44pt | 删一档 / 缩小命中区 ⇒ 各自红 |
| 预览打开后可缩放（缩放比例读数变化）、ESC 可关 | 不传 `appendToEl` 时若被行内 transform 捕获 ⇒ 层级判据红（这条同时是 2.4 的证人） |
| 预览关闭后 blob 被 `dropFull` 释放（不泄漏已解密图） | 摘掉释放 ⇒ 红 |

---

## 11. 明确不做

- 不做"延迟到点前推提醒 / 一键重建"（那是决策 1 的另一选项，已被否）。
- 不做成员侧可见的倒计时（决策 4）。
- 不改 `slotsHeld()` 的名额算法。
- 不改 `ROOM_IDLE_TTL_SECONDS` 的 86400 秒硬顶（那是全局默认值的闸，每房走白名单，两码事）。
- 不给"未进房的邀请页"显示任何剩余时间（会破坏"状态接口只回一个 bit"的不可枚举设计）。
- 不做图片旋转/下载/标注等 PhotoSwipe 顺带能力 —— 需求只要放大缩小等预览操作，YAGNI。

---

## 12. 尚未验证 / 风险登记

| 项 | 状态 | 说明 |
| --- | --- | --- |
| PhotoSwipe 在**真浏览器**里与我们的 CSP、虚拟列表、`overflow-anchor: none` 共存 | 未验 | 实现阶段第一条腿就要跑真 chromium 截图，不看 DOM 存在与否 |
| PhotoSwipe 缺 `width/height` 时的首帧布局 | 未验（但被第 8.5 条规避） | 若仍出现"像素到达时重量"，登记成欠账而不是放宽判据 |
| 72 小时房对 `TEMP_BYTES_MAX_NODE`（20 GiB）的实际压力 | 未验 | 现有额度闸门会在到顶时拒绝，但"20 间房各挂 72h"没有过读数 |
| 门禁在 `MAX_ROOMS=20` 下造不出"5 间已装填"的现场时会不会假绿 | 待验 | 台子跑 lane 时把 `MAX_ROOMS` 提到 80（既有做法），护卡那条判据要显式设小上限，否则夹具撞不到护卡 |
| 公司线（`internal-deploy`）要不要同步这次功能 | 未决 | 该分支今天刚被推过 v1.0.1；同步会再次触发流水线 |
