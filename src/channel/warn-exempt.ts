/**
 * Irmia Agent — 框架预警的**豁免名单**
 *
 * 口径（用户 2026-10-04）：
 *   • 默认**所有单聊、所有群聊都预警**（框架替她留意"这条像不像在给她下指令"）；
 *   • **单聊**可以按会话豁免——那个人是我信得过的，不必每句都过一遍判定；
 *   • **群聊不能整群豁免**：群里谁都可能说话，整群关掉等于对自己人也不设防。
 *     但可以按**已注册的群成员**豁免（他是我信得过的那个人）。
 *
 * 三条实现约束：
 *   1. 与群成员档案一样**不写 config.json**：这是界面在改的东西，配置留给用户手写；
 *   2. 改完**立刻生效**（下一轮就按新名单判），所以每轮 refresh 一次 mtime；
 *   3. 豁免是"**不扫描也不提示**"（省掉那次 light 判定）——不是"照扫只是不说"。
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const WARN_EXEMPT_FILE = 'warn-exempt.json';

interface WarnExemptDoc {
  version: 1;
  /** 豁免预警的单聊会话（sid 形态：`qq:c2c:<openid>`） */
  sessions: string[];
  /** 豁免预警的群成员：群 sid → 成员 openid 列表 */
  members: Record<string, string[]>;
}

export class WarnExemptBook {
  private readonly path: string;
  private sessions: Set<string>;
  private members: Map<string, Set<string>>;
  private mtimeMs: number;

  constructor(dataDir: string) {
    this.path = join(dataDir, WARN_EXEMPT_FILE);
    const loaded = this.load();
    this.sessions = loaded.sessions;
    this.members = loaded.members;
    this.mtimeMs = loaded.mtimeMs;
  }

  private load(): { sessions: Set<string>; members: Map<string, Set<string>>; mtimeMs: number } {
    const sessions = new Set<string>();
    const members = new Map<string, Set<string>>();
    if (!existsSync(this.path)) return { sessions, members, mtimeMs: 0 };
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(this.path).mtimeMs;
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return { sessions, members, mtimeMs };
      const doc = parsed as Partial<WarnExemptDoc>;
      for (const sid of doc.sessions ?? []) if (typeof sid === 'string' && sid !== '') sessions.add(sid);
      for (const [groupSid, list] of Object.entries(doc.members ?? {})) {
        if (!Array.isArray(list)) continue;
        const set = new Set(list.filter((x): x is string => typeof x === 'string' && x !== ''));
        if (set.size > 0) members.set(groupSid, set);
      }
    } catch {
      // 文件坏了当"没人豁免"：预警开着是安全的那一侧
      return { sessions: new Set(), members: new Map(), mtimeMs };
    }
    return { sessions, members, mtimeMs };
  }

  /** 盘上变了就重读（每轮一次 stat） */
  refresh(): void {
    if (!existsSync(this.path)) return;
    let mtimeMs = 0;
    try { mtimeMs = statSync(this.path).mtimeMs; } catch { return; }
    if (mtimeMs === this.mtimeMs) return;
    const loaded = this.load();
    this.sessions = loaded.sessions;
    this.members = loaded.members;
    this.mtimeMs = loaded.mtimeMs;
  }

  sessionSids(): string[] {
    return [...this.sessions];
  }

  memberOpenids(groupSid: string): string[] {
    return [...(this.members.get(groupSid) ?? [])];
  }

  setSession(sid: string, on: boolean): boolean {
    const key = sid.trim();
    if (key === '') return false;
    const had = this.sessions.has(key);
    if (on === had) return false;
    if (on) this.sessions.add(key);
    else this.sessions.delete(key);
    return true;
  }

  setMember(groupSid: string, openid: string, on: boolean): boolean {
    const group = groupSid.trim();
    const who = openid.trim();
    if (group === '' || who === '') return false;
    const set = this.members.get(group) ?? new Set<string>();
    const had = set.has(who);
    if (on === had) return false;
    if (on) set.add(who);
    else set.delete(who);
    if (set.size === 0) this.members.delete(group);
    else this.members.set(group, set);
    return true;
  }

  /**
   * 这条通道消息豁免吗？——**唯一判定入口**，调用方不要自己拼判据。
   *
   * 群聊**永远不认整群豁免**（哪怕配置文件里被人手写了一条 `qq:group:...` 的会话级豁免）：
   * 用户定的口径是"群里只能按人豁免"。所以这里按 chatType 分流，而不是看 sid 在不在名单里。
   */
  isExempt(event: { channel: string; chatType: string; chatId: string; person: string }): boolean {
    const namespace = event.channel === 'onebot' ? 'onebot' : 'qq';
    if (event.chatType === 'c2c') {
      return this.sessions.has(`${namespace}:c2c:${event.chatId}`);
    }
    if (event.chatType === 'group' || event.chatType === 'group-at') {
      const groupSid = `${namespace}:group:${event.chatId}`;
      return (this.members.get(groupSid) ?? new Set<string>()).has(event.person);
    }
    // 频道/私信：用户没提，按"预警开着"处理（安全那一侧）
    return false;
  }

  /** 落盘（原子替换） */
  save(): void {
    const doc: WarnExemptDoc = {
      version: 1,
      sessions: [...this.sessions].sort(),
      members: Object.fromEntries(
        [...this.members.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([groupSid, set]) => [groupSid, [...set].sort()]),
      ),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.path);
    try { this.mtimeMs = statSync(this.path).mtimeMs; } catch { /* 下次 refresh 兜住 */ }
  }

  /** 给界面用：两份名单的原样视图 */
  snapshot(): { sessions: string[]; members: Record<string, string[]> } {
    return {
      sessions: [...this.sessions].sort(),
      members: Object.fromEntries([...this.members.entries()].map(([k, v]) => [k, [...v].sort()])),
    };
  }
}
