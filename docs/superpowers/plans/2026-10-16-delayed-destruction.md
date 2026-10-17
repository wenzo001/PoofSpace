# 延迟销毁（每房 IDLE_GRACE 延长）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 房主可显式把"所有人离线后销毁房间"的窗口从默认 300 秒延长到 4/8/12/24/36/72 小时中的某一档；有人在倒计时期间回房则中断并恢复正常 300 秒，且必须房主重新装填才再次生效。

**Architecture:** `rooms` 加一列可空的 `idle_delay_ms`；**到期时刻永远不落库**，由 `empty_since + effectiveIdleTtlMs(room)` 现算，且全服务只有 `effectiveIdleTtlMs` 一处知道"一间房此刻适用多长窗口"。装填走 HTTP，鉴权复用销毁那条 `creator_token` 路径；节点级 `MAX_DELAYED_ROOMS` 在装填那一刻拒绝，名额算法本身不动。

**Tech Stack:** Next.js 16 App Router、自研 Node 服务器、better-sqlite3（WAL + `secure_delete`）、vitest、Playwright（`scripts/run-browser-tests.mjs` 真浏览器线）。

**Spec:** `docs/superpowers/specs/2026-10-16-delayed-destruction-and-image-preview-design.md` —— 本计划实现该 spec 的 §2.1、§2.2、§3、§4、§5、§6、§7、§9、§10（生命周期/存储/治理三张表）。§2.3、§2.4、§8 与浏览器那张预览表属于**计划二**，不在本文件。

## Global Constraints

每条任务都隐含遵守以下全部（值逐字取自 spec 与现有代码）：

- 服务器**永不得**取得聊天解密密钥；秘密只在 URL `#` fragment 里，绝不发给服务器。
- 日志、异常报告、分析里**不得**出现完整邀请链接、`creator_token`、聊天明文。
- 销毁后**不留房间记录**（无墓碑）：`performCleanup` 删行即 `DESTROYED`，不许新增"延迟记录"表。
- `GET /api/rooms/:id/status` 只回 `{joinable}` 一个 bit —— 不可枚举性优先于便利。
- 装填值只接受白名单 `[4,8,12,24,36,72]` 小时；不接受任意数字。
- `MAX_DELAYED_ROOMS` 默认 `5`，启动校验 `0..maxRooms`；`0` = 整条功能关死。
- `slotsHeld()` 与 `SLOT_HOLDING_STATUSES = ['ACTIVE','IDLE_GRACE','DESTROYING']` **一字不改**。
- `ROOM_IDLE_TTL_SECONDS` 的 `30..86400` 硬顶只管全局默认值，不参与每房白名单。
- 到期判定与取消路径**各两处**，两处都必须走同一真相来源（spec §2.1）。
- 迁移分支必须**成链** `v1→v2→v3`（spec §2.2）—— 不成链会让线上库拒绝开机。
- CSS 一切走 token；触摸目标 ≥44pt；不新增颜色字面量。
- 提交**显式列路径**，禁 `git add -A` / `commit -a`（共享工作树）。
- 每条新判据各自一刀，先证明它会 FAIL 再信它；刀必须先过编译。
- 收尾顺序固定：文档 → 提交 → 打包 → 一遍台面。
- 本地 commit / tag 归 agent；建仓与推送归用户。

---

## 文件结构（先定边界，再拆任务）

| 文件 | 责任 | 动作 |
| --- | --- | --- |
| `src/lib/constants.ts` | 白名单与上限的**唯一来源**：`IDLE_DELAY_CHOICES_MS`、`maxDelayedRoomsDefault` | Modify `:24-43` |
| `src/server/config.ts` | 环境变量 → 已校验配置；`maxDelayedRooms` 落在这里 | Modify `:93-98` 附近 |
| `src/server/db.ts` | 表结构与**成链迁移**；`SCHEMA_VERSION` | Modify `:6`、`:66-80`、`:177-185`、新增 `migrateV2toV3` |
| `src/server/service.ts` | 状态机；`effectiveIdleTtlMs` 单一真相来源；`setIdleDelay` 装填与鉴权 | Modify `:226-231`、`:331-339`、`:895-900`、`:907-931`、`:1085-1095` |
| `src/server/http-api.ts` | `POST /api/rooms/:id/delay` 与房主读路径 | Modify `:172-185` 之后 |
| `src/lib/client/roomclient.ts` | 客户端方法 `setIdleDelay` / `getIdleDelay` | Modify（`destroy` 方法旁） |
| `src/components/DelayDialog.tsx` | 装填弹窗，**新文件**，把 UI 与 `RoomView` 隔开 | Create |
| `src/components/RoomView.tsx` | 页眉那颗只对房主渲染的按钮 | Modify `:505-509` 区 |
| `src/app/globals.css` | 弹窗与页眉按钮样式，全走 token | Modify |
| `tests/storage/schema-migration.test.ts` | 成链迁移的证人 | Create |
| `tests/lifecycle/idle-delay.test.ts` | 生命周期语义 | Create |
| `tests/governance/idle-delay-guard.test.ts` | 白名单 / 护卡 / 鉴权 | Create |
| `scripts/run-browser-tests.mjs` | 房主 UI 的渲染后几何腿 | Modify |
| `docs/*`、`README*`、`CHANGELOG.md` | 对外宣称跟着能力走 | Modify（spec §9 那张表） |

---

## Task 1: 每房窗口列与**成链**迁移

**Files:**
- Modify: `src/server/db.ts:6`（`SCHEMA_VERSION`）、`:66-80`（`ROOMS_TABLE_DDL`）、`:177-185`（构造函数分支）
- Create: `src/server/db.ts` 内 `migrateV2toV3`（放在 `migrateV1toV2` 之后，`:258` 附近）
- Test: `tests/storage/schema-migration.test.ts`

**Interfaces:**
- Consumes: 无（本任务是地基）
- Produces: `rooms.idle_delay_ms INTEGER`（可空）；`SCHEMA_VERSION === 3`；`new Db(file)` 能从 v1 或 v2 升到 v3 且不删任何一行

- [x] **Step 1: 写失败的测试 —— v2 库必须能开机且拿到新列**

创建 `tests/storage/schema-migration.test.ts`。这座库用**旧的 v2 DDL** 手工建，绕开 `Db` 构造函数：

```ts
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Db, SCHEMA_VERSION } from '../../src/server/db';

/** The v2 rooms table, copied from git history. `Db` runs CREATE TABLE IF NOT EXISTS, so
 *  an existing rooms table is exactly the case where a new column silently never arrives. */
const ROOMS_V2 = `CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','IDLE_GRACE','DESTROYING','DESTROYED')),
  join_key BLOB NOT NULL, creator_token BLOB NOT NULL, max_members INTEGER NOT NULL,
  next_slot INTEGER NOT NULL DEFAULT 1, head_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, empty_since INTEGER,
  destroy_reason TEXT, destroyed_at INTEGER, attachment_bytes INTEGER NOT NULL DEFAULT 0
)`;

function seedV2Db(): { file: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poof-mig-'));
  const file = path.join(dir, 'poofspace.sqlite');
  const raw = new Database(file);
  raw.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  raw.exec(ROOMS_V2);
  raw.prepare("INSERT INTO meta (key,value) VALUES ('schema_version','2')").run();
  const t = Date.now();
  raw.prepare(
    `INSERT INTO rooms (id,status,join_key,creator_token,max_members,created_at,updated_at,empty_since)
     VALUES ('r1','IDLE_GRACE',x'00',x'00',100,?,?,?)`
  ).run(t, t, t - 1000);
  raw.close();
  return { file, dir };
}

describe('schema v2 -> v3 keeps the live database bootable', () => {
  it('1. boots a v2 file, adds the column, and deletes no room', () => {
    const { file, dir } = seedV2Db();
    try {
      const db = new Db(file);
      expect(SCHEMA_VERSION).toBe(3);
      const cols = (db.raw.prepare('PRAGMA table_info(rooms)').all() as { name: string }[]).map((c) => c.name);
      expect(cols).toContain('idle_delay_ms');
      expect(db.raw.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '3' });
      expect((db.raw.prepare('SELECT COUNT(*) c FROM rooms').get() as { c: number }).c).toBe(1);
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [x] **Step 2: 跑测试，确认它以"预期的方式"失败**

Run: `node node_modules/vitest/vitest.mjs run tests/storage/schema-migration.test.ts`
Expected: FAIL —— `expect(SCHEMA_VERSION).toBe(3)` 收到 `2`。**不是** `Cannot find module`，也不是 `no such column`（那会是别的错）。

- [x] **Step 3: 加列、升版本、写 `migrateV2toV3`**

`src/server/db.ts:6` 改成 `export const SCHEMA_VERSION = 3;`；`ROOMS_TABLE_DDL`（`:66-80`）在 `attachment_bytes` 那行后加：

```sql
  attachment_bytes INTEGER NOT NULL DEFAULT 0,
  -- Per-room override of the recovery window, armed by the creator and consumed once.
  -- NULL means "use the node default". The expiry instant is never stored: it stays derived
  -- from empty_since, so a restart cannot disagree with a sweep about when a room dies.
  idle_delay_ms INTEGER
```

在 `migrateV1toV2` 之后新增：

```ts
/**
 * v3 adds one nullable column. A nullable ADD COLUMN is in-place in SQLite, so unlike v1->v2
 * there is no reason to rebuild the table -- and every room that is inside its window right now
 * must survive this, because the deployment that carries this code is already running.
 */
function migrateV2toV3(raw: Database.Database): void {
  const cols = (raw.prepare('PRAGMA table_info(rooms)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('idle_delay_ms')) raw.exec('ALTER TABLE rooms ADD COLUMN idle_delay_ms INTEGER');
  const broken = raw.prepare('PRAGMA foreign_key_check').all();
  if (broken.length) throw new Error(`schema migration left ${broken.length} orphan rows`);
}
```

- [x] **Step 4: 把构造函数改成成链，并补 v1 那一支**

`db.ts:177-185` 整块替换。**关键**：`v === 1` 那一支必须两跳都走 —— 各支独立跳号会让 v1 直接标成 3 而永远没有那一列：

```ts
      const row = this.raw.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
      const v = row ? Number(row.value) : SCHEMA_VERSION;
      if (!row) {
        this.raw.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
      } else if (v === 1) {
        migrateV1toV2(this.raw);
        migrateV2toV3(this.raw);
        this.raw.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION), 'schema_version');
      } else if (v === 2) {
        migrateV2toV3(this.raw);
        this.raw.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION), 'schema_version');
      } else if (v !== SCHEMA_VERSION) {
        throw new Error(`Unsupported database schema version ${row.value}; expected ${SCHEMA_VERSION}`);
      }
```

- [x] **Step 5: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run tests/storage/schema-migration.test.ts`
Expected: PASS

- [x] **Step 6: 补 v1 的证人 —— 这一条是"成链"唯一的证据**

在同一文件加第 2 条测试。v1 的 DDL 里 `status` 的 CHECK **不含** `IDLE_GRACE`：

```ts
it('2. a v1 file reaches 3 *with* the column, i.e. the chain does not skip a hop', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poof-mig1-'));
  const file = path.join(dir, 'poofspace.sqlite');
  const raw = new Database(file);
  raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version','1');");
  raw.exec(ROOMS_V2.replace("CHECK (status IN ('ACTIVE','IDLE_GRACE','DESTROYING','DESTROYED'))", "CHECK (status IN ('ACTIVE','DESTROYING','DESTROYED'))"));
  raw.prepare("INSERT INTO rooms (id,status,join_key,creator_token,max_members,created_at,updated_at) VALUES ('r1','ACTIVE',x'00',x'00',100,1,1)").run();
  raw.close();
  try {
    const db = new Db(file);
    const cols = (db.raw.prepare('PRAGMA table_info(rooms)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('idle_delay_ms');
    expect(db.raw.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '3' });
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

Run: `node node_modules/vitest/vitest.mjs run tests/storage/schema-migration.test.ts`
Expected: PASS

- [x] **Step 7: 验牙 —— 摘掉链上的一跳，v1 那条必须红**

临时把 `v === 1` 分支里的 `migrateV2toV3(this.raw);` 删掉，跑：
Expected: **第 2 条红**，签名是 `expect(cols).toContain('idle_delay_ms')` 失败；第 1 条仍绿。
这证明第 2 条测的确实是"成链"，不是"能不能开机"。然后把那一行**放回去**，重跑确认两条都绿。

- [x] **Step 8: 提交**

```bash
git add src/server/db.ts tests/storage/schema-migration.test.ts
git commit -m "feat(db): a per-room recovery window column, reached by a chained migration"
```

---

## Task 2: 单一真相来源 `effectiveIdleTtlMs` 与四处调用者

**Files:**
- Modify: `src/server/service.ts:226-231`（join 取消）、`:331-339`（日志）、`:895-900`（`cancelEmptyTimer`）、`:907-931`（`sweepIdleGrace`）、`:1085-1095`（`recoverOnStartup`）
- Test: `tests/lifecycle/idle-delay.test.ts`

**Interfaces:**
- Consumes: `rooms.idle_delay_ms`（Task 1）
- Produces: `private effectiveIdleTtlMs(room: { idle_delay_ms: number | null }): number`；`sweepIdleGrace(now)` 与 `recoverOnStartup(now)` 都按每房窗口判定；两处取消都把该列清成 `NULL`

- [x] **Step 1: 写失败的测试 —— 装填的房在 71:59:59 还活着**

创建 `tests/lifecycle/idle-delay.test.ts`。`sweepIdleGrace(now)` 与 `recoverOnStartup(now)` 本来就收注入时钟，所以不需要真等：

```ts
import { describe, expect, it } from 'vitest';
import { appendText, join, makeSandbox, seedRoom } from '../helpers/sandbox';

const H = 3_600_000;
const DEFAULT_TTL = 300_000;

/** Reads the two columns this feature owns, straight from the row. */
function delayRow(sbx: ReturnType<typeof makeSandbox>, roomId: string) {
  return sbx.db.raw
    .prepare('SELECT status, empty_since, idle_delay_ms FROM rooms WHERE id=?')
    .get(roomId) as { status: string; empty_since: number | null; idle_delay_ms: number | null };
}

function arm(sbx: ReturnType<typeof makeSandbox>, roomId: string, ms: number) {
  sbx.db.raw.prepare('UPDATE rooms SET idle_delay_ms=? WHERE id=?').run(ms, roomId);
}

function emptyTheRoom(sbx: ReturnType<typeof makeSandbox>, roomId: string, who: { slot: number; gen: number }[]) {
  for (const w of who) sbx.service.leave(roomId, w.slot, w.gen);
}

describe('a per-room window extends the hold without a second deadline', () => {
  it('1. an armed room is still alive at 71:59:59 and gone at 72:00:01', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const a = join(sbx, room, '甲');
      arm(sbx, room.roomId, 72 * H);
      const t0 = Date.now();
      emptyTheRoom(sbx, room.roomId, [a]);
      expect(delayRow(sbx, room.roomId).status).toBe('IDLE_GRACE');

      let out = sbx.service.sweepIdleGrace(t0 + 72 * H - 1_000);
      expect(out.destroyed).toEqual([]);
      expect(delayRow(sbx, room.roomId).status).toBe('IDLE_GRACE');

      out = sbx.service.sweepIdleGrace(t0 + 72 * H + 1_000);
      expect(out.destroyed).toContain(room.roomId);
      await new Promise((r) => setTimeout(r, 150));
      expect(sbx.db.raw.prepare('SELECT COUNT(*) c FROM rooms').get()).toEqual({ c: 0 });
    } finally {
      sbx.close();
    }
  });

  it('2. an unarmed room still dies on the node default', () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const a = join(sbx, room, '甲');
      const t0 = Date.now();
      emptyTheRoom(sbx, room.roomId, [a]);
      expect(sbx.service.sweepIdleGrace(t0 + DEFAULT_TTL + 1_000).destroyed).toContain(room.roomId);
    } finally {
      sbx.close();
    }
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/lifecycle/idle-delay.test.ts`
Expected: 第 1 条 FAIL —— `out.destroyed` 在 `71:59:59` 那次就包含了房间（现在两处判定都还只看全局 300 秒）。第 2 条 PASS（旧行为未动）。

- [x] **Step 3: 加 helper，并让**两处**到期判定都走它**

`service.ts` 里，`sweepIdleGrace` 之前加：

```ts
  /**
   * The window a room is actually held for right now. Both places that decide expiry -- the sweep
   * and startup recovery -- have to ask this one question, because a restart that compared against
   * the node default would destroy every armed room the moment the process came back up, which is
   * exactly the reading no test on the sweep can see.
   */
  private effectiveIdleTtlMs(room: { idle_delay_ms: number | null }): number {
    return room.idle_delay_ms ?? this.cfg.roomIdleTtlMs;
  }
```

`sweepIdleGrace`（`:907-931`）的 SELECT 带上这一列并改判定：

```ts
    const rows = this.db.raw
      .prepare('SELECT id, empty_since, idle_delay_ms FROM rooms WHERE status=\'IDLE_GRACE\'')
      .all() as { id: string; empty_since: number | null; idle_delay_ms: number | null }[];
    ...
      if (now - r.empty_since >= this.effectiveIdleTtlMs(r)) {
```

`recoverOnStartup`（`:1085-1092`）同样：

```ts
    const inGrace = this.db.raw
      .prepare("SELECT id, empty_since, idle_delay_ms FROM rooms WHERE status='IDLE_GRACE'")
      .all() as { id: string; empty_since: number | null; idle_delay_ms: number | null }[];
    ...
      } else if (now - r.empty_since >= this.effectiveIdleTtlMs(r)) {
```

- [x] **Step 4: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run tests/lifecycle/idle-delay.test.ts`
Expected: 两条 PASS

- [x] **Step 5: 验牙 —— 只改一处会怎样（这一刀就是 spec §2.1 的证人）**

临时把 `recoverOnStartup` 那处改回 `this.cfg.roomIdleTtlMs`，加一条测试：

```ts
  it('3. a restart inside the window keeps both the room and its deadline', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const a = join(sbx, room, '甲');
      const t0 = Date.now();
      arm(sbx, room.roomId, 72 * H);
      emptyTheRoom(sbx, room.roomId, [a]);
      const before = delayRow(sbx, room.roomId);
      expect(before.empty_since).not.toBeNull();
      await sbx.service.recoverOnStartup(t0 + 6 * H);
      const after = delayRow(sbx, room.roomId);
      expect(after.status).toBe('IDLE_GRACE');
      expect(after.empty_since).toBe(before.empty_since);
      expect(after.idle_delay_ms).toBe(72 * H);
    } finally {
      sbx.close();
    }
  });
```

Run: `node node_modules/vitest/vitest.mjs run tests/lifecycle/idle-delay.test.ts`
Expected: 第 3 条 **FAIL**（房间被开机判定销毁）。这证明单改清扫不够。然后把 `recoverOnStartup` 的改动**恢复**，重跑三条全绿。

- [x] **Step 6: 两处取消都清掉旗子**

`service.ts:229-231`（join 在 `IDLE_GRACE` 内回房）：

```ts
        this.db.raw
          .prepare(
            "UPDATE rooms SET status='ACTIVE', empty_since=NULL, idle_delay_ms=NULL, updated_at=? WHERE id=?"
          )
          .run(now, input.roomId);
```

`cancelEmptyTimer`（`:897-899`）：

```ts
    this.db.raw
      .prepare(
        "UPDATE rooms SET status='ACTIVE', empty_since=NULL, idle_delay_ms=NULL, updated_at=? WHERE id=? AND status='IDLE_GRACE'"
      )
      .run(Date.now(), roomId);
```

- [x] **Step 7: 补中断语义的两条测试（一次性 + ACTIVE 期不中断）**

```ts
  it('4. a member arriving mid-countdown cancels it AND consumes the arming', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const t0 = Date.now();
      const a = join(sbx, room, '甲');
      arm(sbx, room.roomId, 8 * H);
      emptyTheRoom(sbx, room.roomId, [a]);
      expect(sbx.service.sweepIdleGrace(t0 + 2 * H).destroyed).toEqual([]);
      const b = join(sbx, room, '乙', 1);
      expect(delayRow(sbx, room.roomId).idle_delay_ms).toBeNull();
      expect(delayRow(sbx, room.roomId).status).toBe('ACTIVE');
      // 再空一次：没有旗子了，所以走默认 300 秒
      emptyTheRoom(sbx, room.roomId, [b]);
      const t1 = Date.now();
      expect(sbx.service.sweepIdleGrace(t1 + DEFAULT_TTL + 1_000).destroyed).toContain(room.roomId);
    } finally {
      sbx.close();
    }
  });

  it('5. a join while the room is still ACTIVE leaves the arming in place', () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      arm(sbx, room.roomId, 8 * H);
      join(sbx, room, '甲');
      join(sbx, room, '乙', 1);
      expect(delayRow(sbx, room.roomId).idle_delay_ms).toBe(8 * H);
      expect(delayRow(sbx, room.roomId).status).toBe('ACTIVE');
    } finally {
      sbx.close();
    }
  });
```

Run: `node node_modules/vitest/vitest.mjs run tests/lifecycle/idle-delay.test.ts`
Expected: 五条全 PASS

- [x] **Step 8: 验牙 —— 只清一处**

临时把 `cancelEmptyTimer` 里的 `idle_delay_ms=NULL` 去掉，跑第 4 条。若仍绿，说明那条测试走的是 join 路径而不是 `cancelEmptyTimer` —— 此时**必须补一条走 `cancelEmptyTimer` 的腿**（让 `connected.size > 0` 而库里仍是 `IDLE_GRACE`，再 `sweepIdleGrace`），而不是把"绿"当成没问题。

- [x] **Step 9: 修那句会说谎的日志**

`service.ts:337` 现在打印全局值，装了延迟的房间会留下一条假读数：

```ts
      logger.info('room entered idle grace', {
        roomId,
        windowMs: this.effectiveIdleTtlMs(
          this.db.raw.prepare('SELECT idle_delay_ms FROM rooms WHERE id=?').get(roomId) as { idle_delay_ms: number | null }
        )
      });
```

Run: `node node_modules/vitest/vitest.mjs run tests/lifecycle`
Expected: 全绿（含既有 `idle-grace.test.ts` 那族）

- [x] **Step 10: 提交**

```bash
git add src/server/service.ts tests/lifecycle/idle-delay.test.ts
git commit -m "feat(lifecycle): one source of truth for how long a room is held"
```

---

## Task 3: 装填端点、白名单、名额护卡与房主鉴权

**Files:**
- Modify: `src/lib/constants.ts:24-43`、`src/server/config.ts:93-98`、`src/server/service.ts`、`src/server/http-api.ts:172-185` 之后
- Test: `tests/governance/idle-delay-guard.test.ts`

**Interfaces:**
- Consumes: `rooms.idle_delay_ms`、`effectiveIdleTtlMs`
- Produces: `IDLE_DELAY_CHOICES_MS: readonly number[]`；`cfg.maxDelayedRooms: number`；`service.setIdleDelay(roomId, creatorToken, ms: number | null): { ok: boolean; code?: string }`；`service.idleDelayFor(roomId, creatorToken): { ok: boolean; idleDelayMs: number | null; code?: string }`；HTTP `POST /api/rooms/:id/delay` 与 `GET /api/rooms/:id/delay`

- [x] **Step 1: 写失败的测试 —— 白名单、护卡、鉴权各自一条**

```ts
import { describe, expect, it } from 'vitest';
import { join, makeSandbox, seedRoom } from '../helpers/sandbox';
import { ERR, IDLE_DELAY_CHOICES_MS } from '../../src/lib/constants';

const H = 3_600_000;

describe('arming a delayed destroy', () => {
  it('1. only the six shipped choices are accepted', () => {
    expect(IDLE_DELAY_CHOICES_MS).toEqual([4, 8, 12, 24, 36, 72].map((h) => h * H));
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      join(sbx, room, '甲');
      for (const bad of [5_000, 3 * H, 999 * H, 0, -H]) {
        expect(sbx.service.setIdleDelay(room.roomId, room.creatorToken, bad).code).toBe(ERR.badDelay);
      }
      for (const good of IDLE_DELAY_CHOICES_MS) {
        expect(sbx.service.setIdleDelay(room.roomId, room.creatorToken, good).ok).toBe(true);
      }
      expect(sbx.service.setIdleDelay(room.roomId, room.creatorToken, null).ok).toBe(true);
    } finally {
      sbx.close();
    }
  });

  it('2. the node cap refuses the N+1th arming and names no numbers', () => {
    const sbx = makeSandbox({ maxDelayedRooms: 2 });
    try {
      const rooms = [0, 1, 2].map(() => {
        const r = seedRoom(sbx);
        join(sbx, r, '甲');
        return r;
      });
      expect(sbx.service.setIdleDelay(rooms[0].roomId, rooms[0].creatorToken, 4 * H).ok).toBe(true);
      expect(sbx.service.setIdleDelay(rooms[1].roomId, rooms[1].creatorToken, 4 * H).ok).toBe(true);
      const third = sbx.service.setIdleDelay(rooms[2].roomId, rooms[2].creatorToken, 4 * H);
      expect(third.ok).toBe(false);
      expect(third.code).toBe(ERR.delayCapacityFull);
      // 重新装填已经装填过的那间不算新增
      expect(sbx.service.setIdleDelay(rooms[0].roomId, rooms[0].creatorToken, 8 * H).ok).toBe(true);
    } finally {
      sbx.close();
    }
  });

  it('3. a non-creator token cannot arm, and neither can a wrong-length token', () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      join(sbx, room, '甲');
      expect(sbx.service.setIdleDelay(room.roomId, '', 4 * H).code).toBe(ERR.notCreator);
      expect(sbx.service.setIdleDelay(room.roomId, 'aaaa', 4 * H).code).toBe(ERR.notCreator);
      expect(sbx.service.setIdleDelay(room.roomId, room.creatorToken.slice(0, -2) + 'AA', 4 * H).code).toBe(ERR.notCreator);
      expect(sbx.service.idleDelayFor(room.roomId, 'wrong').code).toBe(ERR.notCreator);
    } finally {
      sbx.close();
    }
  });

  it('4. maxDelayedRooms=0 turns the feature off entirely', () => {
    const sbx = makeSandbox({ maxDelayedRooms: 0 });
    try {
      const room = seedRoom(sbx);
      join(sbx, room, '甲');
      expect(sbx.service.setIdleDelay(room.roomId, room.creatorToken, 4 * H).code).toBe(ERR.delayCapacityFull);
    } finally {
      sbx.close();
    }
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/governance/idle-delay-guard.test.ts`
Expected: FAIL —— `IDLE_DELAY_CHOICES_MS` 未定义 / `setIdleDelay` 不是函数

- [x] **Step 3: 常量与配置**

`src/lib/constants.ts` 的 `LIMITS` 之后加：

```ts
/** The only per-room recovery windows a creator may arm. A fixed set, not a range: it keeps the
 *  72-hour case expressible without borrowing ROOM_IDLE_TTL_SECONDS' 24-hour startup ceiling, and
 *  it leaves no way to smuggle an arbitrary number past the node's own bounds. */
export const IDLE_DELAY_CHOICES_MS = [4, 8, 12, 24, 36, 72].map((h) => h * 3_600_000) as readonly number[];
```

`LIMITS` 里加 `maxDelayedRoomsDefault: 5,`；`ERR` 里加 `badDelay: 'BAD_DELAY_CHOICE'`、`delayCapacityFull: 'DELAY_CAPACITY_FULL'`。

`src/server/config.ts` 的 `AppConfig` 加 `maxDelayedRooms: number;`，`loadConfig` 里 `maxRooms` 那行之后：

```ts
    maxDelayedRooms: bounded('MAX_DELAYED_ROOMS', env.MAX_DELAYED_ROOMS, LIMITS.maxDelayedRoomsDefault, {
      min: 0,
      max: bounded('MAX_ROOMS', env.MAX_ROOMS, LIMITS.maxRoomsDefault, { min: 1, max: LIMITS.maxRoomsHard })
    }),
```

- [x] **Step 4: 服务层装填与读取**

`service.ts` 里 `destroy` 附近加：

```ts
  /**
   * Arms (or clears) this room's own recovery window. Authorized by creator token, exactly like
   * destroy: the `is_creator` slot flag is not an authority, because slot numbers are re-issued.
   */
  setIdleDelay(roomId: string, creatorToken: string, ms: number | null): { ok: boolean; code?: string } {
    if (ms !== null && !IDLE_DELAY_CHOICES_MS.includes(ms)) return { ok: false, code: ERR.badDelay };
    return this.db.tx(() => {
      const room = this.q.getRoom(roomId);
      if (!room || room.status === 'DESTROYING' || room.status === 'DESTROYED') return { ok: false, code: ERR.roomNotFound };
      const given = Buffer.from(creatorToken, 'base64url');
      if (!creatorToken || given.length !== room.creator_token.length || !crypto.timingSafeEqual(given, room.creator_token)) {
        return { ok: false, code: ERR.notCreator };
      }
      if (ms === null) {
        this.db.raw.prepare('UPDATE rooms SET idle_delay_ms=NULL, updated_at=? WHERE id=?').run(Date.now(), roomId);
        return { ok: true };
      }
      // Re-arming a room that is already armed does not consume another unit of the cap, so the
      // owner can move 4h -> 24h without being refused by their own earlier choice.
      if (room.idle_delay_ms === null) {
        const armed = (this.db.raw
          .prepare("SELECT COUNT(*) c FROM rooms WHERE idle_delay_ms IS NOT NULL AND status <> 'DESTROYING'")
          .get() as { c: number }).c;
        if (armed >= this.cfg.maxDelayedRooms) return { ok: false, code: ERR.delayCapacityFull };
      }
      this.db.raw.prepare('UPDATE rooms SET idle_delay_ms=?, updated_at=? WHERE id=?').run(ms, Date.now(), roomId);
      return { ok: true };
    });
  }

  /** The owner's own read of what they armed. Nothing here is exposed to members or to a probe. */
  idleDelayFor(roomId: string, creatorToken: string): { ok: boolean; idleDelayMs?: number | null; code?: string } {
    const room = this.q.getRoom(roomId);
    if (!room) return { ok: false, code: ERR.roomNotFound };
    const given = Buffer.from(creatorToken, 'base64url');
    if (!creatorToken || given.length !== room.creator_token.length || !crypto.timingSafeEqual(given, room.creator_token)) {
      return { ok: false, code: ERR.notCreator };
    }
    return { ok: true, idleDelayMs: room.idle_delay_ms };
  }
```

`q.getRoom` 的 SELECT 与 `RoomRow` 类型要带上 `idle_delay_ms`（`service.ts:139-146` 附近与 `db.ts` 的 row interface）。

- [x] **Step 5: HTTP 两条路由，放在既有 `/destroy` 之后**

`http-api.ts:185` 之后。注意这条路由天然在 `:161` 的 `authorizeToken` **之后** —— 会话 + creator token 两层都要过：

```ts
  if (rest === '/delay' && method === 'POST') {
    const body = await readBody(req, 64 * 1024);
    if (!body) return fail(res, 413, ERR.tooLarge, 'body too large'), true;
    let creatorToken = '';
    let idleDelayMs: number | null = null;
    try {
      const parsed = JSON.parse(body.toString('utf8')) as { creatorToken?: string; idleDelayMs?: number | null };
      creatorToken = String(parsed.creatorToken ?? '');
      idleDelayMs = parsed.idleDelayMs === null || parsed.idleDelayMs === undefined ? null : Number(parsed.idleDelayMs);
    } catch {
      return fail(res, 400, 'BAD_BODY', 'malformed body'), true;
    }
    const out = service.setIdleDelay(roomId, creatorToken, idleDelayMs);
    if (!out.ok) return fail(res, out.code === ERR.roomNotFound ? 404 : 403, out.code ?? ERR.notCreator, 'delay refused'), true;
    json(res, 200, { idleDelayMs });
    return true;
  }

  if (rest === '/delay' && method === 'GET') {
    const out = service.idleDelayFor(roomId, token(req) ?? '');
    if (!out.ok) return fail(res, out.code === ERR.roomNotFound ? 404 : 403, out.code ?? ERR.notCreator, 'unavailable'), true;
    json(res, 200, { idleDelayMs: out.idleDelayMs ?? null });
    return true;
  }
```

- [x] **Step 6: 跑测试确认通过 + 全量不回归**

Run: `node node_modules/vitest/vitest.mjs run tests/governance tests/lifecycle tests/storage`
Expected: 全绿

- [x] **Step 7: 三条验牙**

1. 把 `IDLE_DELAY_CHOICES_MS.includes(ms)` 换成 `ms > 0` ⇒ 第 1 条红（白名单不是范围）。
2. 把护卡那句删掉 ⇒ 第 2 条红。
3. 把 `timingSafeEqual` 换成 `=== room.creator_token.toString('base64url')` 之前，先把 `if (!creatorToken ||` 去掉 ⇒ 第 3 条里空 token 那格红。**每刀单独下、单独跑、看完读数再放回**。

- [x] **Step 8: 提交**

```bash
git add src/lib/constants.ts src/server/config.ts src/server/service.ts src/server/http-api.ts tests/governance/idle-delay-guard.test.ts
git commit -m "feat(api): creator-armed delayed destroy, capped per node and whitelisted per room"
```

---

## Task 4: 房主 UI

**Files:**
- Create: `src/components/DelayDialog.tsx`
- Modify: `src/components/RoomView.tsx:505-509` 区、`src/lib/client/roomclient.ts`、`src/app/globals.css`
- Test: `scripts/run-browser-tests.mjs`

**Interfaces:**
- Consumes: `POST/GET /api/rooms/:id/delay`
- Produces: `roomclient.setIdleDelay(ms: number | null): Promise<boolean>`、`roomclient.getIdleDelay(): Promise<number | null>`；DOM 契约 `.room-head .delay-btn`（只对房主渲染）、`.delay-dialog .opt[data-ms]`

- [x] **Step 1: 客户端方法**（照 `roomclient.ts:799-809` 那个 `destroy` 的形状写，`creatorToken` 走 body 不进 URL）

- [x] **Step 2: 写失败的浏览器腿**（渲染后几何，不是 DOM 存在）：
  - 房主 context 里 `.room-head .delay-btn` 存在、命中区 ≥44×44、中心点在自身形状内；
  - 对端 context 里它**不存在**；
  - 打开弹窗后 `.delay-dialog .opt` 恰好 7 颗（不开启 + 六档），当前值带 `aria-pressed="true"`；
  - 选 8 小时 → 关 → 重开，当前值仍是 8 小时（读的是服务器，不是本地 state）。

- [x] **Step 3: 跑该腿确认红**（`node scripts/run-browser-tests.mjs --only "delay"`，`--only` 匹配的是 checks 数组里的 label）

- [x] **Step 4: 实现 `DelayDialog.tsx`** —— 复用 `Modal`（已 portal 到 body），档位从 `IDLE_DELAY_CHOICES_MS` 派生但**标签写死中文小时数**，期望值不许由被测常量算出。

- [x] **Step 5: 页眉按钮只对 `client.isCreator` 渲染**，与 `RoomView.tsx:505-509` 那颗销毁按钮同一个门。

- [x] **Step 6: CSS 全走 token**，触摸目标 ≥44pt；确认没有第二处 `@media` 重写同一属性。

- [x] **Step 7: 跑该腿确认绿**；再跑整条浏览器线确认没踢红既有腿。

- [x] **Step 8: 验牙**：去掉 `isCreator` 门 ⇒ 对端那条红；把某一档删掉 ⇒ 计数那条红。

- [x] **Step 9: 提交**

---

## Task 5: 对外宣称跟着能力走

**Files:** `docs/SECURITY.md:220`、`README.md`、`README.zh-CN.md`、`docs/ARCHITECTURE.md:104-119`、`docs/DEPLOYMENT.md:189-190`、`CHANGELOG.md`、`docs/TEST-REPORT.md`、`docs/DEBT.md`

- [x] **Step 1:** `SECURITY.md:220` 那句改成"默认 300 秒的有期限例外；房主可显式延到最长 72 小时，且需逐次装填"。
- [x] **Step 2:** README 两份的"无人即销毁"加限定语"无人 **且到期** 即销毁"。
- [x] **Step 3:** `ARCHITECTURE.md` 生命周期一节补：每房窗口、`effectiveIdleTtlMs` 单一真相来源、成链迁移。
- [x] **Step 4:** `DEPLOYMENT.md` 环境变量表加 `MAX_DELAYED_ROOMS`，并写明 `ROOM_IDLE_TTL_SECONDS` 的 24h 硬顶只管全局默认值。
- [x] **Step 5:** `CHANGELOG.md` 一条 Added；`TEST-REPORT.md` 新增一节记本轮逐条读数与每把刀。
- [x] **Step 6:** `DEBT.md` 登记未验项（72h 房对 `TEMP_BYTES_MAX_NODE` 的压力无读数；PhotoSwipe 共存未验属计划二）。
- [x] **Step 7:** 逐条把文档承诺对回代码扫一遍（正反两向），提交。

---

## Task 6: 台面重认证与交付

- [ ] **Step 1:** 产品改动前单跑一遍整跑当改前基线（红就停手报红的腿）。**本轮未做**，偏离已记在 TEST-REPORT §7.14；替代对照是上一轮收尾的 `gates-T`/`gates-V` 与本轮改后的 `gates-W`。
- [x] **Step 2:** `node node_modules/next/dist/bin/next build && node node_modules/typescript/bin/tsc -p tsconfig.server.json`。
- [x] **Step 3:** 整条浏览器线一遍（新增腿计入总数，两来源各一遍）。
- [x] **Step 4:** `node scripts/build-release.mjs --no-build` 重封交付包；核对包内文档与 HEAD 逐个 `git hash-object` 一致、文档闭包审计通过。
- [x] **Step 5:** `node scripts/run-gates.mjs` **前台单条跑**（不许 sleep 轮询 —— 那会 fork 打满进程表并挤崩时序腿），要 `16 passed, 0 failed, 0 skipped`。
- [x] **Step 6:** 崩或红的那一遍**不交任何读数**；结论只来自真跑过判据的那一遍。
- [ ] **Step 7:** 移动/新增 tag 与提交由用户拍板；推送归用户。

---

## Self-Review（写完对照 spec 一遍）

**1. Spec 覆盖**：§2.1→Task 2（含 Step 5 那把"只改一处"的刀）；§2.2→Task 1（含 Step 7 的成链刀）；§3→Task 1+3；§4 状态表→Task 2 五条测试逐行对上；§5→Task 3 Step 2/4；§6→Task 3 Step 4/5；§7→Task 4；§9→Task 5；§10 三张表→Task 1 Step 7、Task 2 Step 5/8、Task 3 Step 7、Task 4 Step 8。**§2.3、§2.4、§8 属计划二，本计划有意不含。**

**2. 占位符扫描**：Task 4 的 Step 1/4/5/6 只描述了动作没给完整代码 —— 那部分依赖 `roomclient.ts`/`RoomView.tsx` 现有形状，执行前要先读那两个文件再落代码，**不接受"照上面感觉写"**。已在任务里标注为需先读。

**3. 类型一致性**：`effectiveIdleTtlMs(room: { idle_delay_ms: number | null })` 在 Task 2 定义、Task 2 Step 3 两处调用签名一致；`setIdleDelay(roomId, creatorToken, ms | null)` 与 Task 3 测试、Task 4 HTTP body 字段名 `idleDelayMs` 一致；`ERR.badDelay` / `ERR.delayCapacityFull` 在 Step 3 定义、Step 4 使用，名字未漂移。

**4. 一处歧义已定死**：`idleDelayFor` 走 `token(req)`（会话 token）而 `setIdleDelay` 走 body 的 `creatorToken` —— 与既有 `/destroy` 完全同形，不新造鉴权口径。
