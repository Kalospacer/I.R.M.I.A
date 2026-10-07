# IRMIA 部署包

从源机器 `~/workspace/irmia` 打包（含数据），2026-10-08。

## 里面有什么

- 全部源码（含两个本地补丁，见下）
- `config.json`（模型、QQ 通道、人格、群白名单都在里面；**密钥不在里面**）
- `data/`（事件日志、人格、记忆）
- `irmia.service` / `reinstall-service.sh`（Linux systemd 用）

## 本地补丁（相对上游 v0.1.0-beta.5）

1. `src/channel/ws-client.ts`：WebSocket 支持 HTTP CONNECT 代理（读 `https_proxy`/`HTTPS_PROXY` 环境变量，无代理时行为不变）。
2. `src/main.ts` + `src/config/config.ts`：`channels.qqOfficial.allowedGroups` / `blockedGroups`（群 openid 数组；白名单外和黑名单的群消息直接丢弃）。

## 部署步骤（Linux / macOS）

```bash
tar xzf irmia-deploy.tar.gz && cd irmia
npm ci
npm run build

# 密钥用环境变量提供（不要写进文件）：
export IRMIA_API_KEY='你的模型key'
export QQ_BOT_APP_ID='你的QQ appid'
export QQ_BOT_CLIENT_SECRET='你的QQ secret'

# 前台跑：
node dist/main.js
# 或用 systemd：按 reinstall-service.sh 的做法装服务
```

## 部署步骤（Windows）

1. 装 Node.js 22+。
2. 解压，`npm ci`，`npm run build`。
3. 设环境变量 `IRMIA_API_KEY` / `QQ_BOT_APP_ID` / `QQ_BOT_CLIENT_SECRET`。
4. `node dist/main.js`；或直接用官方 Flutter GUI（连 127.0.0.1:7788）。

## 当前配置摘要

- 模型：`models.heavy/light` 里配 baseUrl + model，key 走环境变量 `IRMIA_API_KEY`
- QQ 官方通道：已启用（appid 走环境变量 `QQ_BOT_APP_ID`）
- 人格：`data/persona/IDENTITY.md`（一句话）
- 私聊关注：`persona.contacts` 里加自己的 QQ openid（`qq:c2c:<你的openid>`）
- 唤醒词：沐雪、雪
- 群白名单：`channels.qqOfficial.allowedGroups` 里填群 openid（不是群号）
- 工作记忆：128000 token（`persona.compactionThresholdTokens`）
