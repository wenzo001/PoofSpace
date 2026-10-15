import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { adminControlPath, loadConfig } from './config';
import { Db } from './db';
import { RoomStorage } from './storage';

/**
 * The operator entry point: `npm run admin:rooms:disconnect-all` and
 * `npm run admin:data:purge-all`.
 *
 * It is a command run from the deploy directory by someone who already has the OS account and
 * the data directory, and it talks to the running node over the loopback control socket. There
 * is no HTTP admin route on the public listener, no admin entry in the UI and no user role that
 * can reach any of this.
 *
 * Exit codes are part of the contract: 0 done, 1 the operation failed or left the node in
 * maintenance, 2 usage or confirmation refused, 3 the service could not be reached.
 */

type Cmd = 'status' | 'rooms:disconnect-all' | 'data:purge-all';

const EXIT = { ok: 0, failed: 1, usage: 2, unreachable: 3 } as const;

const BLAST_RADIUS: Record<Cmd, string> = {
  status: '只读取聚合计数，不改动任何数据。',
  'rooms:disconnect-all':
    '将停止接受新的创建与加入，把本节点上所有房间推入销毁流程，断开全部 WebSocket，' +
    '取消进行中的上传/下载与后台任务，清除全部密文、附件分片与临时状态，' +
    '并让已断开的客户端无法再用旧链接恢复；完成后重新接受新房间。',
  'data:purge-all':
    '将停止接受任何房间操作，断开全部连接，删除 SQLite 中所有房间、消息、会话、索引与临时记录，' +
    '清空附件目录、未完成分片与孤儿文件，处理 WAL/SHM 并压缩数据库文件。' +
    '所有旧房间、邀请码与会话凭据都将永久不可恢复。'
};

function arg(flags: string[], name: string): string | undefined {
  const i = flags.indexOf(`--${name}`);
  return i >= 0 ? flags[i + 1] : undefined;
}

interface ControlFile {
  port: number;
  token: string;
  pid: number;
}

function readControl(file: string): ControlFile | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as ControlFile;
    if (typeof raw.port !== 'number' || typeof raw.token !== 'string' || !raw.token) return null;
    return raw;
  } catch {
    return null;
  }
}

async function call(control: ControlFile, method: 'GET' | 'POST', route: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${control.port}${route}`, {
    method,
    headers: { authorization: `Bearer ${control.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

function printResult(json: Record<string, unknown>): void {
  // Aggregates only: the response never carries room ids, and nothing here echoes them either.
  const keys = ['ok', 'rooms', 'unfinished', 'connections', 'rows', 'files', 'bytes', 'resumed', 'paused'];
  const counts = [
    'roomsActive',
    'roomsIdleGrace',
    'roomsDestroying',
    'slotsHeld',
    'maxRooms',
    'messages',
    'attachments',
    'online',
    'cleanupPending'
  ];
  const head = keys.filter((k) => json[k] !== undefined).map((k) => `${k}=${String(json[k])}`);
  const tail = counts.filter((k) => json[k] !== undefined).map((k) => `${k}=${String(json[k])}`);
  process.stdout.write(`${head.join(' ')}${head.length && tail.length ? ' | ' : ''}${tail.join(' ')}\n`);
}

/**
 * Cleanup for a node that is stopped: no service holds the file, so the database is emptied,
 * checkpointed, compacted, closed, and only then replaced. Deleting a database the running
 * server still has open is the one thing this command must never do.
 */
async function offlinePurge(cfg: ReturnType<typeof loadConfig>): Promise<number> {
  const db = new Db(cfg.dbFile);
  let removed = 0;
  try {
    removed = db.tx(() => {
      let n = 0;
      for (const t of ['session_tokens', 'attachment_chunks', 'attachments', 'messages', 'slots', 'rooms']) {
        n += db.raw.prepare(`DELETE FROM ${t}`).run().changes;
      }
      return n;
    });
    db.checkpoint();
    db.vacuum();
  } finally {
    db.close();
  }
  const storage = new RoomStorage(cfg.roomsDir);
  const files = await storage.purgeAll();
  // With the connection released the write-ahead artefacts can go too; the database file itself
  // is recreated empty so the next start boots against a schema, not a half-file.
  for (const suffix of ['-wal', '-shm']) {
    fs.rmSync(`${cfg.dbFile}${suffix}`, { force: true });
  }
  fs.rmSync(cfg.dbFile, { force: true });
  new Db(cfg.dbFile).close();
  const leftover = new Db(cfg.dbFile);
  let rows = 0;
  try {
    for (const t of ['session_tokens', 'attachment_chunks', 'attachments', 'messages', 'slots', 'rooms']) {
      rows += (leftover.raw.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
    }
  } finally {
    leftover.close();
  }
  const residualFiles = await storage.countAll();
  process.stdout.write(
    `offline purge rows=${removed} files=${files.files} bytes=${files.bytes} residualRows=${rows} residualFiles=${residualFiles}\n`
  );
  if (rows !== 0 || residualFiles !== 0) {
    process.stderr.write('offline purge left residue; report it, do not call this clean\n');
    return EXIT.failed;
  }
  return EXIT.ok;
}

export async function runAdminCli(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const flags = argv.slice(1);
  if (!cmd || !['status', 'rooms:disconnect-all', 'data:purge-all'].includes(cmd)) {
    process.stderr.write(`usage: admin-cli <status|rooms:disconnect-all|data:purge-all> [--yes] [--offline] [--data-dir <path>]\n`);
    return EXIT.usage;
  }
  const assumeYes = flags.includes('--yes');
  const offline = flags.includes('--offline');
  // Same resolver the server used to write the control file: DATA_DIR, then the documented alias.
  const cfg = loadConfig({
    ...process.env,
    DATA_DIR: path.resolve(arg(flags, 'data-dir') ?? process.env.DATA_DIR ?? process.env.POOFSPACE_DATA_DIR ?? './data')
  } as NodeJS.ProcessEnv);
  const controlFile = adminControlPath(cfg);

  if (cmd === 'data:purge-all' || cmd === 'rooms:disconnect-all') {
    process.stdout.write(`${cmd}\n${BLAST_RADIUS[cmd]}\n`);
  }
  if (cmd === 'data:purge-all') {
    if (!assumeYes) {
      if (!process.stdin.isTTY) {
        process.stderr.write('refused: data:purge-all needs --yes (explicit confirmation) when run non-interactively\n');
        return EXIT.usage;
      }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question('输入 PURGE 确认后再执行：');
      rl.close();
      if (answer.trim() !== 'PURGE') {
        process.stderr.write('cancelled: confirmation not given, nothing was touched\n');
        return EXIT.usage;
      }
    }
  }

  if (offline) {
    if (cmd !== 'data:purge-all') {
      process.stderr.write('refused: --offline is only defined for data:purge-all\n');
      return EXIT.usage;
    }
    const running = readControl(controlFile);
    if (running) {
      try {
        const probe = await call(running, 'GET', '/status');
        if (probe.status === 200) {
          process.stderr.write('refused: the service is running and holds the database open; stop it first (pm2 stop)\n');
          return EXIT.failed;
        }
      } catch {
        /* the recorded port belongs to a process that is already gone */
      }
    }
    return await offlinePurge(cfg);
  }

  const control = readControl(controlFile);
  if (!control) {
    process.stderr.write(`unreachable: no live control socket at ${controlFile}; is the service running?\n`);
    return EXIT.unreachable;
  }
  let response;
  try {
    if (cmd === 'status') response = await call(control, 'GET', '/status');
    else if (cmd === 'rooms:disconnect-all') response = await call(control, 'POST', '/rooms/disconnect-all');
    else response = await call(control, 'POST', '/data/purge-all', { confirm: 'PURGE-ALL-DATA' });
  } catch (err) {
    process.stderr.write(`unreachable: ${String(err)}\n`);
    return EXIT.unreachable;
  }
  printResult(response.json);
  if (response.status !== 200 || response.json.ok === false) {
    process.stderr.write(
      `${cmd} did not complete: the node stays in maintenance and its data is not claimed to be clean\n`
    );
    return EXIT.failed;
  }
  return EXIT.ok;
}

if (require.main === module) {
  runAdminCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`admin command failed: ${String(err)}\n`);
      process.exit(EXIT.failed);
    });
}
