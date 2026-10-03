/**
 * Irmia Agent — 群成员档案（自动注册的落点）
 *
 * 为什么要有它：QQ 官方**不给昵称、也没有查成员的接口**（成员列表要内邀白名单），所以"群里这位是谁"
 * 只能靠消息事件里见过谁。见过的人要有个地方落下，否则每次都只能看她那串 openid。
 *
 * 三条设计约束（都被现实逼出来的）：
 *
 * 1. **不写 config.json**。配置是用户手写的地方（`persona.contacts` 里的"这个会话是用户"）。自动注册
 *    是机器不停在写的东西，两者混在一起，用户一改配置就可能把几百条自动记录覆盖掉。所以单独一个文件
 *    `data/group-members.json`，而且**人写的永远压过自动的**（GUI 里改过一条，它就不再被自动覆盖）。
 * 2. **按 openid 建键，不按 sid**。群成员不是会话：他可能从没私聊过她。按 openid 平铺最省事，
 *    "在哪个群见的"作为字段记着（GUI 要按群分组显示）。
 * 3. **占位号只在没有昵称时发**，而且**按群、按首次出现顺序**发（群友A、群友B…），发了就不改——
 *    她昨天认得"群友A"是甲，今天不能变成乙（这条是 2026-10-03 那次"甲乙丙会飘"的教训）。
 *
 * 名字的权威顺序（与 `real-loop.personNameOf` 一致）：用户手写的联系人表 > 这份档案里的人写条目 >
 * 这份档案里的自动条目 > 她那串 id。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 档案文件名（相对 dataDir） */
export const GROUP_MEMBERS_FILE = 'group-members.json';

/** 占位号的字母表：甲/乙/丙 会与"按批次编号"的旧印象混淆，这里用更容易一眼看出是占位的 A、B、C */
const PLACEHOLDER_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export interface GroupMemberEntry {
  /** 显示名（人写的或自动发的占位名） */
  name: string;
  /** 平台给的昵称/群名片（只作显示，不是身份） */
  nickname?: string;
  /** 在哪个群第一次见到（sid 形态：qq:group:<群id>） */
  groupSid?: string;
  /** 第一次见到的时间（ISO） */
  firstSeenAt?: string;
  /** 最近一次见到的时间（ISO） */
  lastSeenAt?: string;
  /** 'human' = 人改过（自动注册不再覆盖）；'auto' = 自动注册 */
  source: 'human' | 'auto';
}

interface GroupMembersDoc {
  version: 1;
  members: Record<string, GroupMemberEntry>;
}

function emptyDoc(): GroupMembersDoc {
  return { version: 1, members: {} };
}

/** 群成员档案：读写与"该给他起什么名"的唯一实现 */
export class GroupMemberBook {
  private readonly path: string;
  private members: Map<string, GroupMemberEntry>;
  /** 盘上文件的 mtime（毫秒）：变了就重读——她自己/GUI 改了文件，下一轮就该看见 */
  private mtimeMs: number;

  constructor(dataDir: string) {
    this.path = join(dataDir, GROUP_MEMBERS_FILE);
    const loaded = this.load();
    this.members = loaded.members;
    this.mtimeMs = loaded.mtimeMs;
  }

  private load(): { members: Map<string, GroupMemberEntry>; mtimeMs: number } {
    const members = new Map<string, GroupMemberEntry>();
    if (!existsSync(this.path)) return { members, mtimeMs: 0 };
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(this.path).mtimeMs;
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return { members, mtimeMs };
      const raw = (parsed as { members?: unknown }).members;
      if (typeof raw !== 'object' || raw === null) return { members, mtimeMs };
      for (const [openid, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value !== 'object' || value === null) continue;
        const entry = value as Record<string, unknown>;
        const name = typeof entry['name'] === 'string' ? entry['name'].trim() : '';
        if (name === '') continue;
        members.set(openid, {
          name,
          ...(typeof entry['nickname'] === 'string' && entry['nickname'] !== ''
            ? { nickname: entry['nickname'] }
            : {}),
          ...(typeof entry['groupSid'] === 'string' && entry['groupSid'] !== ''
            ? { groupSid: entry['groupSid'] }
            : {}),
          ...(typeof entry['firstSeenAt'] === 'string' ? { firstSeenAt: entry['firstSeenAt'] } : {}),
          ...(typeof entry['lastSeenAt'] === 'string' ? { lastSeenAt: entry['lastSeenAt'] } : {}),
          source: entry['source'] === 'human' ? 'human' : 'auto',
        });
      }
    } catch {
      // 文件坏了就当空的：档案是"方便认人"的东西，读不动不该拦住她做事
      return { members: new Map(), mtimeMs };
    }
    return { members, mtimeMs };
  }

  /** 盘上变了就重读（每轮调一次，代价是一次 stat） */
  refresh(): void {
    if (!existsSync(this.path)) {
      if (this.members.size > 0 && this.mtimeMs !== 0) { this.members = new Map(); this.mtimeMs = 0; }
      return;
    }
    let mtimeMs = 0;
    try { mtimeMs = statSync(this.path).mtimeMs; } catch { return; }
    if (mtimeMs === this.mtimeMs) return;
    const loaded = this.load();
    this.members = loaded.members;
    this.mtimeMs = loaded.mtimeMs;
  }

  /** 查一个人的显示名（没有就 null——调用方自己决定退回 id 还是占位） */
  nameOf(openid: string): string | null {
    const entry = this.members.get(openid);
    return entry === undefined ? null : entry.name;
  }

  /** 全部条目（GUI 按群分组用） */
  all(): Array<{ openid: string; entry: GroupMemberEntry }> {
    return [...this.members.entries()].map(([openid, entry]) => ({ openid, entry }));
  }

  /** 某个群里见过的人（GUI 展开群会话时用） */
  inGroup(groupSid: string): Array<{ openid: string; entry: GroupMemberEntry }> {
    return this.all().filter((item) => item.entry.groupSid === groupSid);
  }

  get size(): number {
    return this.members.size;
  }

  /**
   * 自动注册/更新一个人。返回是否真的改了东西（false = 无需写盘）。
   *
   * 规则：
   *   • 已经有人写的名字（`source: 'human'`）→ **一律不动**（人改过的就是权威）；
   *   • 已经有自动占位名 → 只在**这次拿到了昵称、而原来没有**时更新（补上昵称，不改号）；
   *   • 没见过 → 发一个新占位号（按群、按现有条目数递增），有昵称时同时记下昵称。
   */
  register(input: {
    openid: string;
    groupSid: string;
    nickname?: string;
    at?: string;
  }): boolean {
    const openid = input.openid.trim();
    if (openid === '') return false;
    const nickname = (input.nickname ?? '').trim();
    const now = input.at ?? new Date().toISOString();
    const existing = this.members.get(openid);

    if (existing !== undefined) {
      if (existing.source === 'human') return false;
      let changed = false;
      const next: GroupMemberEntry = { ...existing };
      if (nickname !== '' && (existing.nickname ?? '') !== nickname) {
        // 昵称是我们能拿到的最好线索：显示名跟着昵称走，但**占位号本身不变**
        next.nickname = nickname;
        changed = true;
      }
      if (existing.groupSid === undefined) { next.groupSid = input.groupSid; changed = true; }
      if (existing.lastSeenAt !== now) { next.lastSeenAt = now; changed = true; }
      if (changed) this.members.set(openid, next);
      return changed;
    }

    const placeholder = this.nextPlaceholder(input.groupSid);
    this.members.set(openid, {
      name: nickname === '' ? placeholder : `${placeholder}（群昵称：${nickname}）`,
      ...(nickname === '' ? {} : { nickname }),
      groupSid: input.groupSid,
      firstSeenAt: now,
      lastSeenAt: now,
      source: 'auto',
    });
    return true;
  }

  /** 只补群归属（回填用：人写的名字不动，只记下"这是在哪个群见到的"） */
  setGroup(openid: string, groupSid: string): boolean {
    const key = openid.trim();
    if (key === '') return false;
    const existing = this.members.get(key);
    if (existing === undefined) return false;
    if (existing.groupSid === groupSid) return false;
    this.members.set(key, { ...existing, groupSid });
    return true;
  }

  /** 人改过的名字（GUI 编辑）：写成 `source: 'human'`，从此自动注册不再覆盖 */
  setName(openid: string, name: string, at?: string): boolean {
    const key = openid.trim();
    if (key === '') return false;
    const trimmed = name.trim();
    if (trimmed === '') return false;
    const existing = this.members.get(key);
    const now = at ?? new Date().toISOString();
    this.members.set(key, {
      ...(existing ?? {}),
      name: trimmed,
      ...(existing?.firstSeenAt === undefined ? { firstSeenAt: now } : {}),
      lastSeenAt: now,
      source: 'human',
    });
    return true;
  }

  /** 按群发下一个占位号（A、B、C…；超过 26 个就 AA、AB——不重复是硬要求） */
  private nextPlaceholder(groupSid: string): string {
    const used = new Set(
      [...this.members.values()]
        .filter((entry) => entry.groupSid === groupSid)
        .map((entry) => entry.name.replace(/（.*$/u, '').trim()),
    );
    for (let index = 0; index < 26 * 27; index += 1) {
      const letter = index < 26
        ? PLACEHOLDER_LETTERS[index]!
        : `${PLACEHOLDER_LETTERS[Math.floor(index / 26) - 1]!}${PLACEHOLDER_LETTERS[index % 26]!}`;
      const candidate = `群友${letter}`;
      if (!used.has(candidate)) return candidate;
    }
    return `群友${Date.now()}`;
  }

  /** 落盘（原子替换：先写临时文件再 rename，崩在中间不会留半份档案） */
  save(): void {
    const doc: GroupMembersDoc = { version: 1, members: Object.fromEntries(this.members) };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.path);
    try { this.mtimeMs = statSync(this.path).mtimeMs; } catch { /* 下一次 refresh 会兜住 */ }
  }
}
