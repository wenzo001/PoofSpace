import { randomInt } from './encoding';
import { LIMITS } from './constants';

const SURNAMES = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章';
const GIVEN = [
  '伟','芳','娜','敏','静','丽','强','磊','洋','勇','艳','杰','娟','涛','明','霞','平','刚','桂','兰',
  '文','辉','建','军','波','宁','宇','浩','欣','怡','梓','涵','睿','昊','辰','悦','嘉','宸','萱','瑶',
  '婷','轩','琪','然','安','乐','晨','星','川','林','舟','野','白','原','果','禾','麦','羽','言','青'
];

const AVCOLORS = ['#4fd1c5', '#7dd3fc', '#c4b5fd', '#fca5a5', '#fbbf77', '#86efac', '#f5a3d6', '#a3b8ff'];

export function generateNickname(): string {
  const surname = SURNAMES[randomInt(SURNAMES.length)] as string;
  const single = randomInt(2) === 0;
  const given = single
    ? (GIVEN[randomInt(GIVEN.length)] as string)
    : (GIVEN[randomInt(GIVEN.length)] as string) + (GIVEN[randomInt(GIVEN.length)] as string);
  return surname + given;
}

export function normalizeNickname(raw: string): string {
  const trimmed = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!trimmed) return generateNickname();
  return Array.from(trimmed).slice(0, LIMITS.nickChars).join('');
}

export function avatarChar(nick: string): string {
  const chars = Array.from(nick || '?');
  return (chars[0] as string).toUpperCase();
}

/** Deterministic per nickname so a member looks the same in every client. */
export function avatarColor(nick: string): string {
  let h = 0;
  for (const ch of nick) h = (h * 31 + ch.codePointAt(0)! ) >>> 0;
  return AVCOLORS[h % AVCOLORS.length] as string;
}
