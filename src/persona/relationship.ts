/**
 * Irmia Agent — 关系档案路由（唤醒 → 档案）
 *
 * 只有一件事：**带人的唤醒才注入档案**，判据是 `person` 字段。
 *
 * 为什么单独成文件：real-loop（运行期注入）与 replay（事后重放）必须给出**同一个答案**——
 * 重放的立身之本就是"渲染出与当时一模一样的请求"。这两处曾经各写一份，口径随即漂移
 * （real-loop 支持了 `wake/channel`，replay 还只认 webhook/manual），于是重放出来的请求
 * 少一段档案、与当时对不上。抽成一份之后，这种漂移在结构上就不可能再发生。
 *
 * 带人的三种来源（persona.md §3）：
 *   • `wake/manual`：本机用户自己说话。GUI 聊天框与 CLI `irmia wake` 都带 `persona.owner`
 *     （默认 `owner`），于是 `RELATIONSHIPS/<owner>.md` 自动注入——**档案文件名就是配置里
 *     那个标识**，不是昵称猜出来的；
 *   • `wake/webhook`：外部调用方在 payload 里给 `person`；
 *   • `wake/channel`：IM 发送者标识（私聊是 user_openid、群里是 member_openid——同一个人的
 *     两个不同值，所以同一个人可能对应两份档案）。
 *
 * 找不到文件 = 没有这个人：不注入、不报错、不猜。
 */
import type { AppEvent } from '../log/types.js';
import { loadRelationship } from './loader.ts';

/** 只有这三种唤醒可能带人（其余唤醒类型一律不注入档案） */
const PERSON_WAKE_TYPES: ReadonlySet<string> = new Set([
  'wake/webhook', 'wake/manual', 'wake/channel',
]);

export interface RelationshipNote {
  who: string;
  content: string;
}

/** 唤醒 → 关系档案；没人、没档案、或唤醒类型不带人时返回 null */
export function relationshipForWake(
  wakeEvent: AppEvent | null | undefined,
  dataDir: string,
): RelationshipNote | null {
  if (!wakeEvent) return null;
  if (!PERSON_WAKE_TYPES.has(wakeEvent.type)) return null;
  const data = wakeEvent.data as Record<string, unknown>;
  const person = typeof data['person'] === 'string' ? data['person'].trim() : '';
  if (person !== '') {
    const content = loadRelationship(dataDir, person);
    if (content !== null) return { who: person, content };
  }
  // 发言者没有档案时，**退一步看这个会话本身**有没有。
  //
  // 为什么需要这一步：群消息的 `person` 是**发言者**，而一个刚冒头的人在群里说话，
  // 按 person 查必然查不到——于是那个群自己的档案（她可能早写过"这群一贯聊装机，
  // 气氛还行"）永远注入不进来。用户要的是"她自己维护群聊与某个人的画像"，
  // 这两层得都能落到眼前。会话级档案与话题（`channel/topic`）分工也清楚：
  // 话题是"现在在聊什么"（框架自动概括、有时效），会话档案是"这里一贯如何"（她写的、长期）。
  const chatId = typeof data['chatId'] === 'string' ? data['chatId'].trim() : '';
  if (chatId !== '' && chatId !== person) {
    const content = loadRelationship(dataDir, chatId);
    if (content !== null) return { who: chatId, content };
  }
  return null;
}

/** 手动唤醒该带谁的标识：GUI / CLI / 看门文件三者共用这一处判据 */
export function ownerPersonOf(config: { persona: { owner: string } }): string {
  return config.persona.owner.trim() === '' ? 'owner' : config.persona.owner.trim();
}
