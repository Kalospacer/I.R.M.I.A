/**
 * 工具清单完整性测试 — buildCatalogRegistry
 *
 * 存在的理由：**描述预算是硬门**（design §4.18：单件 ≤100 token），超了 `register` 会抛错、
 * 由 `buildCatalogRegistry` 记进 `problems` 并**跳过那件工具**——于是「她少了件工具」变成一件
 * 只能从行为异常里反推的事。这个坑已经栽过两次：`pwsh`（119 token）与 `speak`（改措辞后又超，
 * 而提示词正让她「必须调用 speak」——她做不到）。
 *
 * 所以这里把说话的两件工具钉死：它们必须在，且必须在模型视线内。
 *
 * v27 补一条：**工具数本身要有断言**。这一轮按参数级审计删了三件、压下七件描述，
 * 而"删掉了什么"这件事如果不锁，下一次有人加回一件别名工具时不会有人发现——
 * 它只会让每轮请求悄悄多付一份 schema。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCatalogRegistry } from '../src/tools/catalog.ts';
import { estimateTokens } from '../src/tools/registry.ts';
import { TimerStore } from '../src/wake/timer-store.ts';

function catalog(destructiveEnabled = true): ReturnType<typeof buildCatalogRegistry> {
  const timers = new TimerStore({ dir: 'data', fire: () => {} });
  return buildCatalogRegistry({ dataDir: 'data', timers, emit: () => {}, destructiveEnabled });
}

test('工具清单：描述超预算的件一个都不许有（会静默少一件能力）', async () => {
  const { problems } = await catalog();
  assert.deepEqual(problems, [], `有工具被跳过：${problems.join('；')}`);
});

test('工具清单：speak 与 report 必须注册成功', async () => {
  const { registry, problems } = await catalog();
  assert.ok(registry.has('speak'), `speak 没注册：${problems.join('；')}`);
  assert.ok(registry.has('report'), `report 没注册：${problems.join('；')}`);
});

test('工具清单：说话的两件工具必须在模型视线内（关不掉的是能力，不是提示词）', async () => {
  const { registry } = await catalog();
  const names = registry.listForModel({ includeDestructive: true }).map((tool) => tool.name);
  assert.ok(names.includes('speak'), 'speak 不在模型清单里，提示词让她调用也没用');
  assert.ok(names.includes('report'), 'report 不在模型清单里');
});

test('工具清单：destructive 打开时 http_download 必须真的注册（她要用它取 QQ 发来的图）', async () => {
  // 这曾经是半截接线：catalog 只往 createNetTools 传了 enablePost，于是 http_download
  // 无论配置怎么写都不存在——而 QQ 富媒体给的是临时直链，没有它就等于"图片收不到"。
  const opened = await catalog();
  const names = opened.registry.listForModel({ includeDestructive: true }).map((tool) => tool.name);
  assert.ok(names.includes('http_download'), '开了 destructive 却没有下载工具，图片链路是断的');
  assert.ok(names.includes('http_post'), 'http_post 与它同一道门，两个都该在');

  const closed = await catalog(false);
  const closedNames = closed.registry.listForModel({ includeDestructive: true }).map((tool) => tool.name);
  assert.ok(!closedNames.includes('http_download'), '默认关闭时不该注册（出网写入类要人显式开）');
});

test('工具清单：run_command / notify 不许回来；ask_human 回来了，但语义换成了"不挂起"', async () => {
  // 415 次真实调用的参数级审计结论：run_command 0 次、notify 与 speak 重复——这两件的理由
  // （每轮为一份重复的 schema 付费）今天照样成立，所以它们仍然不许回来。
  //
  // ask_human 是**唯一被推翻的那一件**：design §6.5 记了那次删除的理由是"挂起一个 turn 等答复
  // （默认 24h）几乎总是浪费"——**错在"等"，不在"问"**。§6 恢复的是"问"：新实现写完
  // `human/asked{source:'agent'}` 就返回，turn 照常往下走（挂起判定只认系统来源），
  // 人的答复在下一拍出现，没人答则落一条「未批准、未拒绝」的事实。
  // 它带来的是**一处新增调用链**，不是旧形态的复活——语义的锁在新用例里：
  // test/human-ask.test.ts「她问人：写完就继续做，turn 不挂起」那一条。
  const { registry } = await catalog();
  for (const gone of ['run_command', 'notify']) {
    assert.equal(registry.has(gone), false, `${gone} 又被注册回来了（每轮都要为它付一份 schema）`);
  }
  // 能力本身必须有替代出口，否则"删了"就成了"没了"
  assert.ok(registry.has('pwsh'), '后台能力要有出口：pwsh');
  assert.ok(registry.has('speak'), '推送能力要有出口：speak 的 level 参数');
  assert.equal(
    (registry.get('speak')?.parameters['properties'] as Record<string, unknown>)['level'] !== undefined,
    true,
    'speak 必须留着 level——它是原来的 notify',
  );

  // ask_human 回来了，且**必须**在模型视线内：她问不到人时只能自己猜
  assert.ok(registry.has('ask_human'), 'ask_human 没注册：§6 的"问"就没有入口');
  const spec = registry.listForModel({ includeDestructive: true }).find((tool) => tool.name === 'ask_human');
  assert.ok(spec !== undefined, 'ask_human 不在模型清单里，提示词让她问也没用');
  // 描述预算是硬门（§4.18）：这一件的常驻开销与其它件同一把尺子
  const tokens = estimateTokens(spec!.description);
  assert.ok(tokens < 60, `ask_human 的描述 ${tokens} token，超过本轮 60 的线`);
});

test('工具清单：七件被压到 60 token 以内的描述不许悄悄长回去', async () => {
  // 单件硬线是 100（超过直接拒绝注册），但这一轮的取舍是**压到 60**：
  // 常驻开销按七件一起算才看得出收益，单看每一件都"还没超线"。
  const { registry } = await catalog();
  const tightened = ['write_persona', 'speak', 'todo', 'vision_read', 'set_timer', 'pwsh', 'safe_edit'];
  for (const name of tightened) {
    const tool = registry.get(name);
    assert.ok(tool !== null, `${name} 不在清单里`);
    const tokens = estimateTokens(tool.description);
    assert.ok(tokens < 60, `${name} 的描述又长回 ${tokens} token（本轮口径：<60）`);
  }
});

test('工具清单：read_file 已改名 safe_read，且行号是**无开关**的默认输出', async () => {
  const { registry } = await catalog();
  assert.equal(registry.has('read_file'), false, 'devkit 原名是 safe_read，read_file 是移植漏改');
  const safeRead = registry.get('safe_read');
  assert.ok(safeRead !== null);
  const props = safeRead.parameters['properties'] as Record<string, unknown>;
  assert.equal('line_numbers' in props, false, '行号不该有开关——它是行号寻址唯一的地址来源');
});
