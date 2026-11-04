#!/usr/bin/env node
/**
 * 侧边会话插件自测（无宿主依赖，纯假的 ctx + 最小 React）。
 *
 * 覆盖：注册面（tab 类型/body/关闭钩子/快捷键/资源提供者）、快捷键 resolve 分支、
 * fork→定标题→开面板→有条件继承模型的调用链、关闭→归档、资源流的 retain/release、
 * tab body 的两种渲染分支（占位 / 正常）。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'

const CODE = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const PARENT = 'session-parent'
const CHILD = 'session-child'
const ADDRESS = `dsh-resource://sidechat/session/${CHILD}`

/* ---------- 载入客户端 bundle ---------- */
let captured = null
new Function('window', CODE)({ __ModuleLoader__: { load: (mod) => { captured = mod } } })
assert.ok(captured, 'client.js 必须调用 window.__ModuleLoader__.load')
assert.equal(captured.id, '@local/dsh-side-chat', '模块 id 必须等于 package.json name')

/* ---------- 假 ctx ---------- */
function createHarness(overrides = {}) {
  const reg = { tabTypes: [], slots: [], closeHandlers: [], providers: [], shortcuts: [] }
  const calls = { fork: [], rename: [], selectModel: [], openResource: [], archive: [], retained: [], released: [] }

  const ctx = {
    sessions: {
      fork: async (opts) => {
        calls.fork.push(opts)
        if (overrides.forkError) throw overrides.forkError
        return overrides.childId ?? CHILD
      },
      list: { getSnapshot: () => ({ byId: overrides.byId ?? {
        /* fork 子会话会继承父会话的持久标题，所以打开那一刻两边都能读到 */
        [PARENT]: { projections: { values: { title: '父标题' } } },
        [CHILD]: { projections: { values: { title: '父标题' } } },
      } }) },
      binding: () => overrides.parentSelection === undefined ? undefined : {
        session: { projections: { faceOf: () => ({ getSnapshot: () => ({ next: overrides.parentSelection, lastUsed: null }) }) } },
      },
      retain: (id) => {
        calls.retained.push(id)
        return { release: () => calls.released.push(id) }
      },
      using: async (id, _options, operation) => operation({
        binding: {
          session: {
            rename: async (title) => { calls.rename.push({ sessionId: id, title }); return { ok: true, value: {} } },
          },
        },
      }),
    },
    resources: { register: (p) => { reg.providers.push(p); return () => {} } },
    sidebarRightTabs: { register: (d) => { reg.tabTypes.push(d); return () => {} } },
    sidebarRight: {
      mounted: { getSnapshot: () => overrides.mounted },
      openResource: (address, options) => calls.openResource.push({ address, options }),
      registerCloseHandler: (kind, handler) => { reg.closeHandlers.push({ kind, handler }); return () => {} },
    },
    slots: {
      inject: (_name, cb) => cb(),
      register: (spec, comp) => { reg.slots.push({ spec, comp }); return () => {} },
    },
    shortcuts: { register: (cmd) => { reg.shortcuts.push(cmd); return () => {} } },
    workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: overrides.archived ?? [] }) } },
    uiWorkspace: { archiveSession: async (id, options) => calls.archive.push({ id, options }) },
    remote: {
      session: {
        rename: async (req) => { calls.rename.push(req); return { ok: true, value: {} } },
        modelCatalog: async () => ({ ok: true, value: { default: overrides.defaultSelection ?? { provider: 'p', model: 'm', reasoningEffort: 'high' } } }),
        selectModel: async (req) => { calls.selectModel.push(req); return { ok: true, value: {} } },
      },
    },
    effect: (fn) => { fn() },
    inject: (_deps, cb) => { cb(ctx) },
  }
  return { ctx, reg, calls }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))
const loadPlugin = () => captured.factory((name) => name === 'react' ? { createElement: () => null } : { createPortal: (n) => n })

/* ---------- 1. 注册面 ---------- */
{
  const { ctx, reg } = createHarness({ mounted: PARENT })
  const plugin = loadPlugin()
  assert.ok(plugin.inject.includes('sessions'))
  plugin.apply(ctx)

  assert.equal(reg.tabTypes.length, 1, '应注册 1 个 tab 类型')
  assert.equal(reg.slots.length, 2, '应注册 tab body + 对话体两个槽')
  assert.equal(reg.closeHandlers.length, 1, '应注册 1 个关闭钩子')
  assert.equal(reg.shortcuts.length, 1, '应注册 1 个快捷键')
  assert.equal(reg.providers.length, 1, '应注册 1 个资源提供者')

  const type = reg.tabTypes[0]
  assert.equal(type.id, '@local/dsh-side-chat', 'tab 实现 id = 包名')
  assert.equal(type.kind, 'sidechat')
  assert.deepEqual(type.patterns, ['dsh-resource://sidechat/session/**'])
  assert.equal(type.canOpen(ADDRESS), true)
  assert.equal(type.canOpen('dsh-resource://file/session/x/y.md'), false)
  assert.equal(type.title('dsh-resource://sidechat/session/unknown'), '侧聊')

  const paneTab = reg.slots.find((s) => s.spec.name === 'sidebar.right.pane.tab')
  const chatSlot = reg.slots.find((s) => s.spec.name === 'sidechat.chat')
  assert.ok(paneTab, '必须注册 sidebar.right.pane.tab 本体')
  assert.ok(chatSlot, '必须自己注册 sidechat.chat 对话体（跨插件复用 sidebar.chat.conversation 不生效）')
  assert.equal(paneTab.spec.key, '@local/dsh-side-chat')
  assert.deepEqual(paneTab.spec.children, { 'sidechat.chat': { kind: 'single', scope: 'session' } })

  const shortcut = reg.shortcuts[0]
  assert.equal(shortcut.id, 'sidechat.open')
  assert.deepEqual(shortcut.defaults['web:windows'], { code: 'KeyS', modifiers: ['primary', 'alt'] })
  assert.deepEqual(shortcut.defaults['desktop:windows'], { code: 'KeyS', modifiers: ['primary', 'alt'] })
  assert.equal(reg.providers[0].protocol, 'sidechat')
}

/* ---------- 2. 快捷键：无会话时 blocked ---------- */
{
  const { ctx, reg } = createHarness({ mounted: undefined })
  loadPlugin().apply(ctx)
  const resolution = reg.shortcuts[0].resolve({ region: 'page', modal: null, target: null })
  assert.equal(resolution.status, 'blocked')
}

/* ---------- 3. 快捷键：fork → 开面板 → 定标题；模型与默认相同时不写 ---------- */
{
  const { ctx, reg, calls } = createHarness({
    mounted: PARENT,
    parentSelection: { provider: 'p', model: 'm', reasoningEffort: 'high' },
  })
  loadPlugin().apply(ctx)

  const resolution = reg.shortcuts[0].resolve({ region: 'page', modal: null, target: null })
  assert.equal(resolution.status, 'handled')
  resolution.run()
  await tick(); await tick()

  assert.deepEqual(calls.fork, [{ sessionId: PARENT }], 'fork 不带 atSeq（取最近已完成轮次）')
  assert.equal(calls.openResource.length, 1)
  assert.ok(calls.openResource[0].address.startsWith(ADDRESS), '地址前缀必须是本插件的会话地址')
  assert.match(calls.openResource[0].address, /\?t=/, '标题必须编进地址，tab 打开时就地取用')
  assert.equal(calls.openResource[0].options.kind, 'sidechat')
  assert.equal(calls.rename[0].title, '侧聊·父标题')
  assert.equal(calls.selectModel.length, 0, '与默认一致时不应调用 selectModel')
  assert.equal(reg.tabTypes[0].title(calls.openResource[0].address), '侧聊·父标题', 'tab 打开时应已拿到标题')
  assert.equal(reg.tabTypes[0].title(ADDRESS), '侧聊·父标题', '没编标题时退回会话投影')
}

/* ---------- 4. 模型与默认不同 → 继承 ---------- */
{
  const { ctx, reg, calls } = createHarness({
    mounted: PARENT,
    parentSelection: { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'max' },
  })
  loadPlugin().apply(ctx)
  reg.shortcuts[0].resolve({ region: 'page', modal: null, target: null }).run()
  await tick(); await tick(); await tick()

  assert.equal(calls.selectModel.length, 1)
  assert.deepEqual(calls.selectModel[0], { sessionId: CHILD, provider: 'zai', model: 'glm-5.3', reasoningEffort: 'max' })
}

/* ---------- 5. fork 失败：提示但不崩、不开面板 ---------- */
{
  const error = Object.assign(new Error('no completed turn'), { rpcError: { code: 'session/fork-unavailable', message: 'x' } })
  const { ctx, reg, calls } = createHarness({ mounted: PARENT, forkError: error })
  loadPlugin().apply(ctx)
  reg.shortcuts[0].resolve({ region: 'page', modal: null, target: null }).run()
  await tick(); await tick()
  assert.equal(calls.openResource.length, 0)
  assert.equal(calls.archive.length, 0)
}

/* ---------- 6. 关闭 → 归档（带 stopActivity） ---------- */
{
  const { ctx, reg, calls } = createHarness({ mounted: PARENT })
  loadPlugin().apply(ctx)
  reg.closeHandlers[0].handler(PARENT, { contentId: ADDRESS })
  await tick()
  assert.deepEqual(calls.archive, [{ id: CHILD, options: { stopActivity: true } }])

  // 别的 tab 关掉不该触发归档
  reg.closeHandlers[0].handler(PARENT, { contentId: 'dsh-resource://file/session/x/a.md' })
  await tick()
  assert.equal(calls.archive.length, 1)
}

/* ---------- 7. 资源流：retain → 首个 ok 帧 → abort 后 release ---------- */
{
  const { ctx, reg, calls } = createHarness({ mounted: PARENT })
  loadPlugin().apply(ctx)
  const provider = reg.providers[0]
  const controller = new AbortController()
  const stream = provider.open(ADDRESS, { signal: controller.signal })
  const first = await stream.next()
  assert.equal(first.value.ok, true)
  assert.equal(first.value.value.sessionId, CHILD)
  assert.deepEqual(calls.retained, [CHILD])
  controller.abort()
  const done = await stream.next()
  assert.equal(done.done, true)
  assert.deepEqual(calls.released, [CHILD], 'abort 后必须释放 retain 引用')
}

/* ---------- 8. tab body 分支 + 对话体兜底 + 归档自动关 tab ---------- */
{
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children: children.length === 1 ? children[0] : children } }),
    useEffect: (fn) => { fn() },
  }
  const plugin = captured.factory((name) => name === 'react' ? react : {})
  const { ctx, reg } = createHarness({ mounted: PARENT })
  plugin.apply(ctx)
  const Body = reg.slots.find((s) => s.spec.name === 'sidebar.right.pane.tab').comp
  const Conversation = reg.slots.find((s) => s.spec.name === 'sidechat.chat').comp

  const render = (component, props) => {
    const walk = (n) => {
      if (n === null || n === undefined) return ''
      if (typeof n === 'string' || typeof n === 'number') return String(n)
      if (Array.isArray(n)) return n.map(walk).join('')
      if (typeof n.type === 'function') return walk(n.type(n.props))
      return walk(n.props?.children)
    }
    return walk(component(props))
  }

  const tabProps = (extra) => ({
    useResource: () => ({ status: 'live', value: { sessionId: CHILD, reference: {} }, failure: undefined }),
    useTabInfo: () => ({ tab: { contentId: ADDRESS, actions: { close: extra?.close ?? (() => {}) } } }),
    useWorkspaces: (select) => select({ archivedSessionIds: extra?.archived ?? [] }),
    SessionProvider: ({ children }) => children,
    renderSlot: (name) => `[slot:${name}]`,
  })

  // 8a 占位（还没有 value）
  const loading = render(Body, {
    ...tabProps(),
    useResource: () => ({ status: 'loading', value: undefined, failure: undefined }),
  })
  assert.match(loading, /正在打开侧边会话/)

  // 8b 正常：把会话交给 SessionProvider，再渲染自己的对话槽
  assert.match(render(Body, tabProps()), /\[slot:sidechat\.chat\]/)

  // 8c 该会话在左侧树被归档 → 自动关 tab
  let closed = 0
  const archivedView = render(Body, tabProps({ archived: [CHILD], close: () => { closed += 1 } }))
  assert.equal(closed, 1, '归档后必须调用 tab.actions.close()')
  assert.match(archivedView, /该会话已归档/)

  // 8d 对话体：有内容时透传工厂槽，没有时给诊断文案而不是空白
  const conversationProps = (content) => ({
    sessionId: CHILD,
    useSession: (select) => select({ blank: false, awaitingFirstTurn: false, running: false, openState: 'open', promptAttempted: true }),
    useConversation: (select) => select({ activeTargets: new Set() }),
    useSessions: (select) => select({ byId: { [CHILD]: { blank: false } } }),
    renderFactorySlot: () => content,
  })
  assert.match(render(Conversation, conversationProps('[factory:conversation.content]')), /\[factory:conversation\.content\]/)
  assert.match(render(Conversation, conversationProps(null)), /对话内容暂不可用/)
}

/* ---------- 9. 已归档的会话被关闭时不再重复归档 ---------- */
{
  const { ctx, reg, calls } = createHarness({ mounted: PARENT, archived: [CHILD] })
  loadPlugin().apply(ctx)
  reg.closeHandlers[0].handler(PARENT, { contentId: ADDRESS })
  await tick()
  assert.equal(calls.archive.length, 0)
}

console.log('✓ side-chat 客户端自测全部通过')
