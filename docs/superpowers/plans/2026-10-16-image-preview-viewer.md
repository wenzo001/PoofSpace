# 图片预览缩放（PhotoSwipe 薄适配器）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现在那层只会"整块点一下就关"的图片预览换成支持滚轮/双击缩放、拖拽平移、前后翻页、ESC 关闭的查看器，且不把已解密的图片泄漏到别处、不重新踩层叠上下文那个坑。

**Architecture:** 一个薄适配器组件 `src/components/ImagePreview.tsx` 独占对 PhotoSwipe DOM 的一切接触；调用方只给它 `SlideData[]`（`src` 是我们按需解密出来的 blob URL）。原图宽高在上传时读一次、随 meta 一起加密，查看器因此不必等图片 load 完才知道尺寸。

**Tech Stack:** `photoswipe@5.4.4`（MIT、ESM、`dependencies: {}` 零传递依赖）、React 19 / Next 16 App Router、真浏览器线 `scripts/run-browser-tests.mjs`（Playwright + 盘上 chromium）。

**Spec:** `docs/superpowers/specs/2026-10-16-delayed-destruction-and-image-preview-design.md` §2.3、§2.4、§8、§10 的浏览器那张表。生命周期部分在 `2026-10-16-delayed-destruction.md`，本计划不碰。

## Global Constraints

- 不引 CDN、不在运行时从网络取加密实现；新增依赖必须进交付包并被产物审计看见。
- 生产 CSP 不因本功能放宽（现状 `style-src 'self' 'unsafe-inline'`，`src/server/config.ts:136`，**不改**）。
- 已解密的图片只活在 blob URL 里；预览关闭必须 `dropFull` 释放，不许留悬垂 URL。
- 浮层必须挂在 `document.body`，**显式传，不赌库的默认值**。
- 判据打在渲染后的几何上，不打在"DOM 里有没有这个节点"。
- CSS 一切走 token；触摸目标 ≥44pt；不新增颜色字面量。
- 每条新判据各自一刀，刀必须先过编译。
- 提交显式列路径，禁 `git add -A` / `commit -a`。
- 收尾顺序：文档 → 提交 → 打包 → 一遍台面。

---

## 已验事实（写代码前不必再猜的部分）

全部实测自 `npm pack photoswipe@5.4.4` 解出来的 `package/dist/`：

| 主张 | 证据 |
| --- | --- |
| 零传递依赖、MIT、ESM | `package/package.json`：`license: MIT`、`type: module`、`dependencies: {}` |
| ESC 关闭、左右键翻页、Tab 焦点圈 | `dist/photoswipe.esm.js` 内 `'Escape'`、`'ArrowLeft'`、`'ArrowRight'`、`'Tab'` |
| 双击缩放、滚轮缩放 | 同文件内 `doubleTap`、`doubleTapAction`、`wheel`、`wheelToZoom`、`zoomLevel` |
| 可以直接喂数据、不需要 `<a href>` | `DataSource = SlideData[] | DataSourceObject`（`dist/types/photoswipe.d.ts:32-37`），`loadAndOpen(index, dataSource?)`（`lightbox.d.ts:85`） |
| **`appendToEl` 不在 `LightboxOptions` 上** | 只在 `photoswipe.d.ts:180`（`PhotoSwipeOptions`） |
| **但运行时能传到核心** | `photoswipe-lightbox.esm.js:1901-1902`：`new module(this.options)` —— 整个 options 原样交给 PhotoSwipe 构造 |
| 库会写一个全局 | 同文件 `:1903` `window.pswp = pswp` |

⇒ 适配器必须用一个交叉类型把 `appendToEl` 合法地传进去，否则 tsc 拦下（运行时本来是通的，这是**类型面的缺口**，不是能力缺口）。

---

## 文件结构

| 文件 | 责任 | 动作 |
| --- | --- | --- |
| `scripts/run-gates.mjs:251` | B2 的依赖名单从事实派生 | Modify（**前置**：先让"新增依赖"这件事本身有红灯） |
| `src/lib/client/media.ts` | 新增 `imageDims()`：上传前读一次原图尺寸 | Modify |
| `src/components/RoomView.tsx:262-268` | 上传时把宽高塞进 `upload()` | Modify |
| `src/lib/client/roomclient.ts:641-651` | `upload(opts)` 已支持 `width?/height?`，无需改签名 | 只读确认 |
| `src/components/ImagePreview.tsx` | **唯一**碰 PhotoSwipe DOM 的文件 | Create |
| `src/components/RoomView.tsx:929-938` | 用适配器替换现有 `.lightbox` | Modify |
| `src/app/globals.css:1023-1042`、`:1325-1329` | 删掉旧 `.lightbox` 那套 | Modify |
| `package.json` / `package-lock.json` | 新增 `photoswipe@5.4.4` | Modify |
| `tests/unit/media-dims.test.ts` | 宽高真的进了 meta | Create |
| `scripts/run-browser-tests.mjs` | 缩放/ESC/翻页/层级/释放 五条腿 | Modify |

---

## Task 1: 先让"新增依赖"这件事有红灯（B2 从事实派生）

**Files:**
- Modify: `scripts/run-gates.mjs:251`
- Test: 台面 B2 本身

**Interfaces:**
- Consumes: `release/build-info.json` 的 `packages[].id`（形如 `ws@8.22.0`）
- Produces: B2 的 `expected` 变成"包里那份 `package.json` 的 `dependencies` 键集"

- [ ] **Step 1: 先量一次"现在的 B2 有多没牙"**

在**不加任何依赖**的今天，把 staged 包里 `node_modules/ws` 临时改名，跑 `node scripts/run-gates.mjs`，看 B2。
Expected: FAIL 并点名 `ws`（因为 `ws` 在硬编码名单里）。改回来。

- [ ] **Step 2: 记下这个形状 —— 它就是本任务的存在理由**

`node -e "const b=require('./release/build-info.json');console.log(b.packages.length)"` 记下当前包树数（上一轮是 60）。
本任务完成后，任何一个**声明了却没进包**的依赖都必须让 B2 红，而不只是名单里那 7 个。

- [ ] **Step 3: 改判据**

`scripts/run-gates.mjs:251` 那一行替换为：

```js
      // Derived from the shipped manifest, not hand-copied: a hand copy only ever complains about
      // the names someone remembered to add to it, so a new runtime dependency that never reached
      // the artifact would pass. This reads the same source of truth the packager walked.
      const expected = Object.keys(
        JSON.parse(fs.readFileSync(path.join(artifact, 'package.json'), 'utf8')).dependencies ?? {}
      );
```

- [ ] **Step 4: 跑台面确认未回归**

Run: `node scripts/run-gates.mjs`
Expected: `16 passed, 0 failed, 0 skipped`（B2 的 evidence 行里 `missing=none`，包数不变）

- [ ] **Step 5: 验牙 —— 名单里每一个都得有牙**

把 `node_modules/ws` 改名 ⇒ B2 红并点名 `ws`；改回。再把 `node_modules/@noble/hashes` 改名 ⇒ 红并点名它。
Expected: 两次都红，且红的是**不同**的名字（这才叫逐个有牙，不是只守第一个）。全部改回后重跑确认 16/0/0。

- [ ] **Step 6: 提交**

```bash
git add scripts/run-gates.mjs
git commit -m "test(gates): derive the artifact dependency check from the shipped manifest"
```

---

## Task 2: 原图宽高进 meta（查看器的尺寸来源）

**Files:**
- Modify: `src/lib/client/media.ts`（`thumbnailUrl` 附近，`:54` 前后）
- Modify: `src/components/RoomView.tsx:262-268`（upload 调用）
- Test: `tests/unit/media-dims.test.ts`

**Interfaces:**
- Consumes: `roomclient.upload(opts.width?, opts.height?)`（`roomclient.ts:647-648` 已支持）
- Produces: `imageDims(file: Blob): Promise<{ width: number; height: number } | null>`；`AttachmentMeta.width/height` 在图片上传后**非空**

- [ ] **Step 1: 写失败的测试**

`AttachmentMeta` 的字段是可选的，所以这条判据要钉的是"上传之后确实被填了"，不是"类型里有"：

```ts
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { LIMITS } from '../../src/lib/constants';

/** The claim being pinned: the uploader reads the original size once, on the client, and puts it
 *  in the encrypted meta -- because a viewer that has to wait for the image to load before it
 *  knows the size re-measures the row at the moment the pixels arrive, which is a bug we already
 *  fought once this month. */
describe('image metadata carries the original size', () => {
  it('the upload path passes width/height through to meta', () => {
    const src = fs.readFileSync(path.resolve('src/components/RoomView.tsx'), 'utf8');
    const call = /\.upload\(\{([^}]*)\}\)/s.exec(src);
    expect(call, 'the .upload({...}) call site disappeared').not.toBeNull();
    expect(call![1]).toMatch(/width:/);
    expect(call![1]).toMatch(/height:/);
    expect(src).toMatch(/imageDims\(/);
  });

  it('media.ts exposes imageDims and closes its bitmap', () => {
    const media = fs.readFileSync(path.resolve('src/lib/client/media.ts'), 'utf8');
    expect(media).toMatch(/export async function imageDims/);
    expect(media).toMatch(/bitmap\.close\(\)/);
    expect(LIMITS).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/unit/media-dims.test.ts`
Expected: 第 1 条 FAIL —— `width:` 不在 upload 调用的实参里。

- [ ] **Step 3: `media.ts` 加 `imageDims`**

放在 `thumbnailUrl` 之前。`bitmap.close()` 必须有，否则整张原图解码结果会一直挂在内存里：

```ts
/**
 * The original pixel size, read once before upload. The thumbnail path already decodes the file
 * and knows these numbers and then throws them away; the viewer needs them, and inferring them
 * after the image loads would re-measure the layout at the moment the pixels arrive.
 */
export async function imageDims(file: Blob): Promise<{ width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const dims = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dims;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 上传时带上**

`RoomView.tsx` 的 `enqueue` 上传那一段（`:262-268`）改成先量再传。`kind` 已由文件类型决定（上一轮的改动），这里只加尺寸：

```ts
      const dims = job.kind === 'image' ? await imageDims(job.file) : null;
      await client
        .upload({
          name: job.name,
          mime: job.file.type || 'application/octet-stream',
          size: job.file.size,
          kind: job.kind,
          width: dims?.width,
          height: dims?.height,
          slice
        })
```

- [ ] **Step 5: 跑测试确认通过 + 单元/集成不回归**

Run: `node node_modules/vitest/vitest.mjs run tests/unit tests/integration`
Expected: 全绿

- [ ] **Step 6: 验牙**

把 `width: dims?.width` 删掉 ⇒ 第 1 条红。把 `bitmap.close()` 删掉 ⇒ 第 2 条红。各自单独下刀、各自看到红、各自放回。

- [ ] **Step 7: 提交**

```bash
git add src/lib/client/media.ts src/components/RoomView.tsx tests/unit/media-dims.test.ts
git commit -m "feat(chat): carry the original image size in the encrypted attachment meta"
```

---

## Task 3: `ImagePreview.tsx` 薄适配器

**Files:**
- Create: `src/components/ImagePreview.tsx`
- Modify: `src/components/RoomView.tsx:929-938`、`src/app/globals.css:1023-1042` 与 `:1325-1329`

**Interfaces:**
- Consumes: `fullUrl(client, id, meta)` / `dropFull(id)`（`media.ts:92-124`）、`AttachmentMeta.width/height`（Task 2）
- Produces: `<ImagePreview items={...} index={...} onClose={...} />`；对外 DOM 契约只有 `[data-preview="viewer"]` 与 `[data-preview="zoom"]` 两个钩子（库自己的 class 一律不出这个文件）

- [ ] **Step 1: 装依赖**

```bash
npm install photoswipe@5.4.4 --save-exact
```

确认 `package.json` 里是精确版本 `"photoswipe": "5.4.4"`（不是 `^`）：一个未固定的第三方查看器进了交付包，回滚面就大了。

- [ ] **Step 2: 写适配器**

```tsx
'use client';

import { useEffect, useRef } from 'react';
import PhotoSwipeLightbox from 'photoswipe/lightbox';
import 'photoswipe/style.css';
import type { PhotoSwipeOptions } from 'photoswipe';

export interface PreviewItem {
  src: string;
  width: number;
  height: number;
  alt: string;
}

/**
 * One file owns everything PhotoSwipe's DOM looks like, so the browser legs judge our geometry
 * instead of a third party's class names.
 *
 * appendToEl is a PhotoSwipe option, not a Lightbox option -- but the Lightbox hands its whole
 * options object to the core (`new module(this.options)`), so passing it works at runtime and only
 * needs the intersection to satisfy tsc. It is passed explicitly on purpose: the default is not a
 * guarantee, and a viewer mounted inside a virtual-list row would be captured by that row's
 * transform, which is the exact bug the portal exists to prevent.
 */
type LightboxOpts = NonNullable<ConstructorParameters<typeof PhotoSwipeLightbox>[0]> &
  Pick<PhotoSwipeOptions, 'appendToEl'>;

export default function ImagePreview({ items, index, onClose }: { items: PreviewItem[]; index: number; onClose: () => void }) {
  const closing = useRef(false);

  useEffect(() => {
    const lb = new PhotoSwipeLightbox({
      appendToEl: document.body,
      dataSource: items.map((it) => ({ src: it.src, width: it.width, height: it.height, alt: it.alt })),
      bgOpacity: 0.92,
      showHideAnimationType: 'zoom',
      pswpModule: () => import('photoswipe'),
      wheelToZoom: true,
      doubleTapAction: 'zoom',
      spacing: 0.08,
      maxSpreadZoom: 4,
      modal: true,
      closeOnEsc: true,
      arrowKeyPaths: { toNext: true, toPrev: true }
    } as LightboxOpts);

    lb.on('close', () => {
      if (closing.current) return;
      closing.current = true;
      onClose();
    });
    lb.init();
    lb.loadAndOpen(Math.max(0, Math.min(index, items.length - 1)));
    return () => {
      lb.destroy();
      lb.off('close');
    };
  }, [items, index, onClose]);

  return null;
}
```

**执行时必须逐条核对的两件事**（选项名以 `dist/types/photoswipe.d.ts` 与 `dist/types/lightbox/lightbox.d.ts` 为准，上面这份是按 5.4.4 的类型写的；若某个选项名不存在，tsc 会立刻指出，**不要**用 `as any` 把它糊过去）：
1. `closeOnEsc` / `arrowKeyPaths` / `maxSpreadZoom` / `spacing` 是否都在 `PhotoSwipeOptions` 上；
2. `dataSource` 传 `SlideData[]` 时 `alt` 字段名是否为 `alt`。

- [ ] **Step 3: 接上调用方**

`RoomView.tsx:929-938` 那段 `.lightbox` 换成：

```tsx
      {zoom ? (
        <ImagePreview
          items={previewItems}
          index={zoom.index}
          onClose={() => {
            dropFull(zoom.id);
            setZoom(null);
          }}
        />
      ) : null}
```

`previewItems` 由**当前会话里已解密过的图片消息**按 `seq` 顺序映射而来（`src` 用 `fullUrl` 的结果，`width/height` 用 meta；meta 缺尺寸的旧消息回落到 `1,1`，由浏览器 load 后自然修正 —— 这是**已知的回落**，要写进注释与 §12 风险，不许悄悄兜底）。

- [ ] **Step 4: 删掉旧样式**

`globals.css:1023-1042`（`.lightbox`、`.lightbox img`）与 `:1325-1329`（`.lightbox .icon-btn`）整块删除。
删之前先 `grep -n "lightbox" src/` 确认没有别处还在用这个名字。

- [ ] **Step 5: 编译与类型**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
Expected: 0 error。若报选项不存在 → 按 Step 2 的核对清单改名，**不要**加 `as any`（那会把"这个选项到底存不存在"这个问题从编译期推到线上）。

- [ ] **Step 6: 提交**

```bash
git add package.json package-lock.json src/components/ImagePreview.tsx src/components/RoomView.tsx src/app/globals.css
git commit -m "feat(chat): a real image viewer, with the library DOM behind one adapter"
```

---

## Task 4: 浏览器线的五条腿

**Files:**
- Modify: `scripts/run-browser-tests.mjs`

**Interfaces:**
- Consumes: Task 3 的 `[data-preview]` 钩子（若 Step 2 决定不加钩子，则腿里只允许出现 `pswp` 前缀的 class **一次**，在文件顶部集中定义）
- Produces: 五条新腿，各自一条判据、各自一把刀

- [ ] **Step 1: 逐条写腿，每条都先跑一遍确认它现在会红**（因为 Task 3 已实现，先跑可能直接绿 —— 那时改用"先注释实现再跑"的顺序，绿不算证）

| 腿 | 判据（渲染后几何） | 刀 |
| --- | --- | --- |
| `the preview outranks the chat it came from`（既有，改指新 DOM） | 预览容器 `parentElement === document.body`；中心像素 `elementFromPoint` 命中查看器的图 | 去掉 `appendToEl` ⇒ 红（这一刀同时是 spec §2.4 的证人） |
| `the preview zooms` | 打开后读缩放比例 `a`，滚轮上滚 ⇒ 读到 `b`，判 `b > a`；再下滚 ⇒ 判回落 | 传 `maxSpreadZoom: 1` ⇒ 缩放那条红 |
| `the preview pans when zoomed` | 放大后拖拽中心 ⇒ 图像包围盒左移 ≥40px | 关掉拖拽 ⇒ 红 |
| `the preview pages between images` | 发两张图，打开第一张，按 ArrowRight ⇒ 命中的 `src` 变成第二张 | 关掉 `arrowKeyPaths` ⇒ 红 |
| `the preview releases the decrypted image on close` | 关闭后 `fullUrl` 的 blob 已被 revoke（`dropFull` 生效）：再取同一 id 走一次重新解密路径 | 摘掉 `onClose` 里的 `dropFull` ⇒ 红 |

- [ ] **Step 2: ESC 与"点图不再误关"两条行为并进 `the preview zooms` 的判据里**（现状那两个是真缺陷：ESC 不存在、点图片本身会关闭）

- [ ] **Step 3: 整条浏览器线跑一遍**（两来源），确认新腿计入总数且既有腿未回归

Run: `node scripts/run-browser-tests.mjs`
Expected: `PASS = 腿数 × 2`，`FAIL/SKIP = 0`，`LANE_EXIT=0`

- [ ] **Step 4: 亲自看截图**（这个仓库已经证明过：27 条腿全绿时只有看截图能抓到问题）

起一台临时服务器（**按 PID 收尾**），跑 `scratch/visual-check5.mjs` 的同类探针，看放大态、翻页态、手机上双击缩放三张图。

- [ ] **Step 5: 提交**

---

## Task 5: 交付与文档

- [ ] **Step 1:** `node scripts/build-release.mjs`（这次**要**重编，因为多了依赖）；确认产物审计里包树数比 60 大且含 `photoswipe`。
- [ ] **Step 2:** `node scripts/run-gates.mjs` 前台单条跑 ⇒ `16 / 0 / 0`。B2 的 evidence 行必须看得见 `photoswipe` 在包内。
- [ ] **Step 3:** 文档：`README*` 的预览那句改成"缩放、平移、翻页、ESC"；`CHANGELOG.md` 一条 Changed；`ARCHITECTURE.md` 记"第三方 DOM 只出现在 `ImagePreview.tsx`"这条边界；`DEPLOYMENT.md` 的依赖闭包数字更新。
- [ ] **Step 4:** `TEST-REPORT.md` 新增一节：逐条读数 + 五把刀 + Step 1 那次"先跑可能直接绿"的处置。
- [ ] **Step 5:** `DEBT.md` 登记：旧消息 meta 无尺寸时回落 `1,1`（结案读数 = 给一条旧格式夹具跑预览，判它不崩且 load 后尺寸被修正）；`window.pswp` 这个全局是库写的，不是我们的。
- [ ] **Step 6:** 台面重认证收尾（文档 → 提交 → 打包 → 一遍台面），tag 与推送由用户拍板。

---

## Self-Review

**1. Spec 覆盖**：§2.3→Task 1（含 Step 5 的两把刀）；§2.4→Task 3 Step 2 的 `appendToEl` + Task 4 第一把刀；§8.1-8.4→Task 3；§8.5→Task 2；§8.6→Task 1+Task 5 Step 1；§10 浏览器表→Task 4。**§9 的宣称改动属计划一，两计划各自持有。**

**2. 占位符扫描**：Task 3 Step 3 的 `previewItems` 与 Task 4 Step 1 的部分实现细节给的是"要产出什么形状 + 去哪核对"，不是可粘贴的完整代码 —— 执行到那一步必须先读 `RoomView.tsx` 的 `zoom` state 与 `media.ts` 的缓存表，再落代码。**不许凭这份计划的感觉编。**

**3. 类型一致性**：`PreviewItem{src,width,height,alt}` 在 Task 3 定义、Task 4 的判据只读渲染结果不依赖它；`imageDims` 返回 `{width,height}|null` 与 Task 2 Step 4 的 `dims?.width` 一致；`dropFull`/`fullUrl` 沿用现有名字未改。

**4. 一处歧义已定死**：`maxSpreadZoom: 1` 作为刀会让"缩放"腿红，但它同时可能影响"平移"腿 —— 两把刀**必须分开下**，一次只动一个 observable，否则红的集合说不清是谁守的。
