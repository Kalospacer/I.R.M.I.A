/**
 * 极简 DOM 桩 —— 只服务 test/shell-pages.test.ts
 *
 * 目的：在 node --test 里真的跑一遍每页的 init()，验证"渲染出自己的标题、四态容器在、cleanup 是函数"。
 * 不追求 DOM 语义完整：querySelector 返回一个固定的万能子桩，页面拿不到真元素也不会炸——
 * 页面本就该对"元素不存在"容错，这个桩顺带测了这一点。
 */

type Any = any;

export interface DomHandle {
  /** 页面容器（壳里传给 init 的那个 section） */
  el: Any;
  /** 桩里的 document（可查 registry：mountSprite 注进去的 sprite 容器） */
  doc: Any;
  /** 清空 localStorage 桩，避免用例之间互相污染 */
  resetStorage(): void;
  /** 设置 hash（页内二级 tab 靠它分流） */
  setHash(hash: string): void;
}

/**
 * 万能元素桩：所有属性可读写，方法都是空操作。
 * querySelector 返回惰性子桩（两层足够：页面 → 块容器），子桩的 querySelector 指向自己。
 */
function makeStub(tag: string): Any {
  const el: Any = {
    tagName: tag.toUpperCase(),
    dataset: {},
    style: {},
    classList: {
      add(): void {},
      remove(): void {},
      toggle(): void {},
      contains(): boolean {
        return false;
      },
    },
    children: [] as Any[],
    attributes: {} as Record<string, string>,
    innerHTML: '',
    textContent: '',
    value: '',
    hidden: false,
    checked: false,
    disabled: false,
    scrollTop: 0,
    clientHeight: 0,
    offsetHeight: 0,
    parentElement: null as Any,
    appendChild(child: Any): Any {
      el.children.push(child);
      child.parentElement = el;
      return child;
    },
    insertBefore(child: Any): Any {
      el.children.unshift(child);
      return child;
    },
    removeChild(child: Any): Any {
      el.children = (el.children as Any[]).filter((item) => item !== child);
      return child;
    },
    remove(): void {},
    setAttribute(key: string, value: unknown): void {
      el.attributes[key] = String(value);
    },
    getAttribute(key: string): string | null {
      return el.attributes[key] ?? null;
    },
    removeAttribute(key: string): void {
      delete el.attributes[key];
    },
    addEventListener(): void {},
    removeEventListener(): void {},
    dispatchEvent(): boolean {
      return true;
    },
    focus(): void {},
    blur(): void {},
    click(): void {},
    scrollIntoView(): void {},
    closest(): Any {
      return null;
    },
  };
  // 惰性子桩：页面里 el.querySelector('#x') 拿到一个可写可改的万能元素；
  // 再深的查询在子桩上自引用（页面的查询深度就到这一层），不会无限展开。
  let childStub: Any = null;
  el.querySelector = (): Any => {
    if (childStub === null) {
      childStub = makeStub('div');
      childStub.parentElement = el;
      childStub.querySelector = () => childStub;
    }
    return childStub;
  };
  el.querySelectorAll = (): Any[] => [];
  return el;
}

/** 装一套最小全局：document / location / localStorage / window / requestAnimationFrame */
export function installDom(): DomHandle {
  const registry = new Map<string, Any>();
  const storage = new Map<string, string>();

  const body = makeStub('body');
  const documentElement = makeStub('html');
  const documentStub: Any = {
    body,
    documentElement,
    createElement: (tag: string) => makeStub(tag),
    createElementNS: (_ns: string, tag: string) => makeStub(tag),
    getElementById: (id: string) => registry.get(id) ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(): void {},
    removeEventListener(): void {},
  };
  // body.appendChild 会登记带 id 的容器：mountSprite 的幂等判断靠它
  const rawAppend = body.appendChild.bind(body);
  body.appendChild = (child: Any): Any => {
    if (child?.id !== undefined && child.id !== '') registry.set(String(child.id), child);
    return rawAppend(child);
  };

  const locationStub: Any = { hash: '#/', pathname: '/', search: '', href: 'http://127.0.0.1/' };
  const localStorageStub: Any = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: unknown) => { storage.set(key, String(value)); },
    removeItem: (key: string) => { storage.delete(key); },
    clear: () => { storage.clear(); },
  };
  const windowStub: Any = {
    addEventListener(): void {},
    removeEventListener(): void {},
    matchMedia: () => ({ matches: false, addEventListener(): void {} }),
  };

  const g = globalThis as Any;
  const setGlobal = (key: string, value: Any): void => {
    try {
      g[key] = value;
    } catch {
      /* 只读全局：个别宿主的全局不让改，忽略即可（页面不依赖它也能跑） */
    }
  };
  setGlobal('document', documentStub);
  setGlobal('location', locationStub);
  setGlobal('localStorage', localStorageStub);
  setGlobal('window', windowStub);
  setGlobal('matchMedia', windowStub.matchMedia);
  if (typeof g.requestAnimationFrame !== 'function') {
    setGlobal('requestAnimationFrame', (fn: Any) => {
      const handle = setTimeout(() => fn(Date.now()), 0);
      return handle;
    });
    setGlobal('cancelAnimationFrame', (handle: Any) => clearTimeout(handle));
  }

  const el = makeStub('section');
  return {
    el,
    doc: documentStub,
    resetStorage: () => storage.clear(),
    setHash: (hash: string) => { locationStub.hash = hash; },
  };
}

/** 端点默认返回：形状与 src/web/server.ts 对齐，够页面画出"空态" */
export function defaultPayload(path: string): Any {
  const bare = path.split('?')[0] ?? path;
  switch (bare) {
    case '/api/projection':
      return {
        lastSeq: 0, watermark: 0, pending: [], openTurn: null, openTools: [], needsReview: [], planPending: [],
        planApproved: [], timers: [], claimedByTurn: {}, intentions: [], todoList: [], jobs: {}, waitingHuman: null,
        lastExhausted: {}, dedupeKeys: [], lastModelSuccessAt: null, firstEventAt: null, failStreak: 0, degraded: null,
        idleTicks: 0, lastWake: null, lastAssistantText: null, lastAssistantAt: null, deadLetters: [], lastArchiveAt: null,
        pressure: 0.05,
        budget: { tokensToday: 0, tokensTodayHeavy: 0, tokensTodayLight: 0, cacheHitToday: 0, cacheMissToday: 0, tokensTask: 0, stepsThisTurn: 0, toolCallsThisStep: 0 },
      };
    case '/api/stats/dashboard':
      return { state: 'idle', stateText: '我在呢', detail: '', tiles: {}, budget: {}, hourly: [], recent: [], suggestions: [], guardedDays: 0, empty: false, personaProposals: 0 };
    case '/api/budget':
      return { range: 'today', today: { tokens: 0, heavy: 0, light: 0 }, layers: [], limits: {}, series: [], turns: [], month: {} };
    case '/api/events':
      return { events: [], nextBeforeSeq: null };
    case '/api/persona/files':
      return { root: '', files: [], relationships: [], proposals: [] };
    case '/api/persona/file':
      return { path: 'IDENTITY.md', content: '# 我是谁', reserved: false, tokens: 0 };
    case '/api/persona/history':
      return { entries: [] };
    case '/api/config':
      return {
        schemaVersion: 1, dataDir: 'C:/tmp/data', timezone: 'Asia/Shanghai',
        web: { host: '127.0.0.1', port: 7788 },
        channels: {
          qqOfficial: { enabled: false, appIdEnv: 'IRMIA_QQ_APP_ID', clientSecretEnv: 'IRMIA_QQ_SECRET' },
          onebot: { enabled: false, wsUrl: 'ws://127.0.0.1:3001', tokenEnv: 'IRMIA_ONEBOT_TOKEN' },
        },
        alerts: { rateLimitMin: 30 }, tools: { destructiveEnabled: false, planMode: false }, paths: { workspaceAllowlist: [] },
      };
    case '/api/skills':
      return { items: [], rejected: [], catalogTokens: 0, entries: [] };
    case '/api/mcp':
      return { servers: [], problems: [], registeredCount: 0 };
    case '/api/hooks':
      return { entries: [], problems: [], relative: 'data/hooks.json', exists: false, readOnlyForAgent: [] };
    case '/api/tools':
      return { tools: [], count: 0, destructivePolicy: false };
    case '/api/alarms':
      return { files: [], relative: 'alarms' };
    case '/api/doctor':
      return { items: [], events: { shards: 0, maxSeq: 0, badLines: 0 }, failures: 0, skips: 0 };
    case '/api/replay':
      return { request: { messages: [] }, usage: {}, fingerprints: {} };
    default:
      return {};
  }
}

/** 壳的 ctx 桩：token + api(path, opts) + setBadge，默认吐"空态"数据（永不 401） */
export function makeCtx(handler?: (path: string, opts?: Any) => Any): Any {
  const calls: Array<{ path: string; opts: Any }> = [];
  /** 页面往壳回写的导航徽章流水（聊天未读 / 待确认红点）：桩里只记账 */
  const badges: string[] = [];
  return {
    token: 'test-token-shell-pages',
    online: true,
    calls,
    badges,
    setBadge(page: string, text: string | null): void {
      badges.push(`${page}:${text === null ? 'off' : text}`);
    },
    async api(path: string, opts?: Any): Promise<Any> {
      calls.push({ path, opts });
      if (handler !== undefined) {
        const out = handler(path, opts);
        if (out instanceof Error) throw out;
        if (out !== undefined) return out;
      }
      return defaultPayload(path);
    },
  };
}
