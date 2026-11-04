/**
 * DSH「侧边会话」：Ctrl+Alt+S 从当前会话分叉一份上下文，在右栏开一个独立对话，关闭即归档。
 *
 * 设计约束（已在实现前与用户确认）：
 * - 继承上下文 = 宿主 fork，切到「最近已完成轮次」的事件前缀；是快照，不是与父会话活共享。
 * - 模型 = 有条件继承：父会话的选择与全局默认不同时，fork 后补一次 selectModel。
 * - 关闭 = 归档（DSH 无会话删除接口）；归档行可在「显示已归档」里恢复。
 */

window.__ModuleLoader__.load({
  id: 'dsh-side-chat-panel',
  factory: (require) => {
    const react = require('react')
    const h = react.createElement

    /** tab 类型名，同时也是关闭钩子的通道名与 slot body 的注册 key。 */
    const KIND = 'sidechat'
    const PLUGIN_ID = '@local/dsh-side-chat'
    const ADDRESS_PREFIX = 'dsh-resource://sidechat/session/'
    const TITLE_PREFIX = '侧聊·'

    /** fork 后、tab 打开前先写好的标题；tab 的 title() 在打开那一刻同步取用。 */
    const pendingTitles = new Map()

    const T = {
      text1: 'var(--dsw-alias-label-primary)',
      text2: 'var(--dsw-alias-label-secondary)',
      text3: 'var(--dsw-alias-label-tertiary)',
      radiusMd: 'var(--dsw-radius-md, 12px)',
      cardFill: 'var(--dsw-alias-settings-card-fill, rgba(255,255,255,0.04))',
      cardStroke: 'var(--dsw-alias-settings-card-stroke, rgba(255,255,255,0.12))',
    }

    // ── 资源地址 ────────────────────────────────────────────────────────────
    /** @param {string} sessionId 会话 id @returns {string} 资源地址 */
    function addressOf(sessionId) {
      return ADDRESS_PREFIX + encodeURIComponent(String(sessionId))
    }

    /**
     * 从资源地址解析侧聊会话 id；不是本插件的地址时返回 undefined。
     * @param {string} address 资源地址
     * @returns {string|undefined} 会话 id
     */
    function sessionOfAddress(address) {
      let url
      try {
        url = new URL(String(address))
      } catch {
        return undefined
      }
      if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== 'sidechat') return undefined
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts.length !== 2 || parts[0] !== 'session') return undefined
      try {
        return decodeURIComponent(parts[1])
      } catch {
        return undefined
      }
    }

    // ── 提示条（纯 DOM，失败不抛）────────────────────────────────────────────
    let toastTimer = null

    /** 在视口底部浮一条提示，4 秒后自动消失；任何异常都吞掉。 */
    function showToast(message) {
      try {
        let node = document.getElementById('dsh-side-chat-toast')
        if (node === null) {
          node = document.createElement('div')
          node.id = 'dsh-side-chat-toast'
          node.style.cssText =
            'position:fixed;left:50%;bottom:36px;transform:translateX(-50%);z-index:2147483000;' +
            'max-width:min(560px,calc(100vw - 48px));padding:10px 16px;border-radius:10px;' +
            'font-size:13px;line-height:18px;pointer-events:none;box-shadow:0 8px 28px rgba(0,0,0,0.28);' +
            'background:' + T.cardFill + ';border:1px solid ' + T.cardStroke + ';color:' + T.text1
          document.body.appendChild(node)
        }
        node.textContent = message
        node.style.display = 'block'
        if (toastTimer !== null) clearTimeout(toastTimer)
        toastTimer = setTimeout(() => {
          node.style.display = 'none'
          toastTimer = null
        }, 4000)
      } catch {
        /* 提示条是锦上添花，出现异常不影响主流程 */
      }
    }

    // ── 会话信息读取 ────────────────────────────────────────────────────────
    /** 读会话投影里的标题；读不到返回 undefined。 */
    function titleOf(ctx, sessionId) {
      try {
        const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
        return summary?.projections?.values?.title ?? summary?.projections?.title ?? undefined
      } catch {
        return undefined
      }
    }

    /** 读父会话当前模型三元组（provider/model/reasoningEffort）；读不到返回 undefined。 */
    function selectionOf(ctx, sessionId) {
      try {
        const binding = ctx.sessions.binding(sessionId)
        const face = binding?.session?.projections?.faceOf?.('modelSelection')
        const snapshot = face?.getSnapshot?.()
        const selection = snapshot?.next ?? snapshot?.lastUsed
        return selection === null || selection === undefined ? undefined : selection
      } catch {
        return undefined
      }
    }

    function sameSelection(left, right) {
      if (left === undefined || right === undefined) return false
      return (
        left.provider === right.provider &&
        left.model === right.model &&
        (left.reasoningEffort ?? '') === (right.reasoningEffort ?? '')
      )
    }

    // ── 资源提供者：一个地址 = 一个被 retain 的会话 ──────────────────────────
    /**
     * 侧聊资源：地址里编的是普通会话 id，右侧面板据此 retain 该会话并渲染它的对话。
     * @param {object} sessions ctx.sessions
     */
    function sideChatResourceProvider(sessions) {
      return {
        protocol: 'sidechat',
        async *open(address, { signal }) {
          const sessionId = sessionOfAddress(address)
          if (sessionId === undefined) throw new Error(`side-chat: invalid chat address "${String(address)}"`)
          const reference = sessions.retain(sessionId, { source: 'sideChat', signal })
          try {
            yield { ok: true, value: { sessionId, reference } }
            await new Promise((resolve) => {
              if (signal.aborted) {
                resolve()
                return
              }
              signal.addEventListener('abort', resolve, { once: true })
            })
          } finally {
            reference.release()
          }
        },
      }
    }

    // ── tab body：把保留住的会话接到共享的对话槽上 ───────────────────────────
    /** 面板空态 / 载入态 / 失败态。 */
    function SideChatPlaceholder({ resource }) {
      const failed = resource.status === 'failed'
      const message = failed
        ? '侧边会话不可用：' + String(resource.failure?.message ?? '未知错误')
        : '正在打开侧边会话…'
      return h(
        'div',
        {
          style: {
            display: 'flex',
            flex: '1 1 auto',
            minHeight: 0,
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
            fontSize: 13,
            lineHeight: '20px',
            color: failed ? 'var(--dsw-alias-state-error-primary)' : T.text3,
            textAlign: 'center',
          },
        },
        message,
      )
    }

    /** 右栏 tab 本体：会话由 SessionProvider 注入，对话内容复用 sidebar.chat.conversation。 */
    function SideChatTab(props) {
      const { useResource, useTabInfo, SessionProvider, renderSlot } = props
      const info = useTabInfo()
      const tab = info.tab
      const resource = useResource(tab.contentId)
      const value = resource.value
      if (value === undefined) return h(SideChatPlaceholder, { resource })
      return h(
        'div',
        {
          style: { display: 'flex', flex: '1 1 auto', minWidth: 0, minHeight: 0, width: '100%', height: '100%' },
          'data-side-chat': '',
        },
        h(SessionProvider, { session: value.reference }, renderSlot('sidebar.chat.conversation', {})),
      )
    }

    // ── 打开 / 归档 ─────────────────────────────────────────────────────────
    /** 把 fork 失败翻译成一句人话。 */
    function describeForkFailure(error) {
      const code = error?.rpcError?.code ?? error?.code
      if (code === 'session/fork-unavailable') return '当前会话还没有已完成的轮次，先聊一轮再开侧边会话'
      if (code === 'session/migration-required') return '当前会话需要先打开一次完成格式迁移'
      if (code === 'session/not-found') return '当前会话已不存在'
      return '打开侧边会话失败：' + String(error?.message ?? error)
    }

    /**
     * Ctrl+Alt+S 的主流程：fork → 定标题 → 开右栏 tab → 补标题/模型。
     * @param {object} ctx 客户端上下文
     * @param {string} parentId 主会话 id
     */
    async function openSideChat(ctx, parentId) {
      let childId
      try {
        // 省略 atSeq：宿主取「最近已完成轮次」前缀
        childId = await ctx.sessions.fork({ sessionId: parentId })
      } catch (error) {
        showToast(describeForkFailure(error))
        return
      }

      const parentTitle = titleOf(ctx, parentId)
      const title = parentTitle === undefined ? '侧聊' : TITLE_PREFIX + parentTitle
      pendingTitles.set(childId, title)

      // 先开面板给反馈，再补标题与模型
      ctx.sidebarRight.openResource(addressOf(childId), { kind: KIND })
      void renameSideChat(ctx, childId, title)
      void inheritModel(ctx, parentId, childId)
    }

    /** 归档行上的可读标题；失败只是标题不好看，不影响打开。 */
    async function renameSideChat(ctx, childId, title) {
      try {
        await ctx.remote.session.rename({ sessionId: childId, title })
      } catch (error) {
        console.warn('side-chat: 重命名侧边会话失败', error)
      }
    }

    /**
     * 有条件继承模型：父会话的选择与全局默认不同才写一次。
     * 副作用说明：宿主 selectModel 会顺带把该选择存为默认模型，所以“相同就不写”。
     */
    async function inheritModel(ctx, parentId, childId) {
      try {
        const selection = selectionOf(ctx, parentId)
        if (selection === undefined) return
        const remote = ctx.remote?.session
        if (remote?.modelCatalog === undefined) return
        const catalog = await remote.modelCatalog()
        const fallback = catalog.ok ? catalog.value.default : undefined
        if (sameSelection(selection, fallback)) return
        const result = await remote.selectModel({
          sessionId: childId,
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        })
        if (!result.ok) console.warn('side-chat: 继承模型被拒绝', result.error?.code, result.error?.message)
      } catch (error) {
        console.warn('side-chat: 继承模型失败', error)
      }
    }

    /** 关闭即归档：停止仍在跑的工作并归档，之后可在已归档视图恢复。 */
    async function archiveSideChat(ctx, childId) {
      try {
        await ctx.uiWorkspace.archiveSession(childId, { stopActivity: true })
      } catch (error) {
        console.warn('side-chat: 归档侧边会话失败', error)
      }
    }

    // ── 插件主体 ────────────────────────────────────────────────────────────
    const inject = ['sessions', 'slots', 'sidebarRight', 'uiWorkspace']

    function apply(ctx) {
      // 资源 + tab 类型 + body：三者都依赖 resources/sidebarRightTabs，缺一个就整体不注册
      ctx.inject(['resources', 'sidebarRightTabs'], (scope) => {
        scope.effect(() => scope.resources.register(sideChatResourceProvider(ctx.sessions)), 'side-chat: resource provider')

        scope.effect(
          () =>
            scope.sidebarRightTabs.register({
              id: PLUGIN_ID,
              kind: KIND,
              patterns: [ADDRESS_PREFIX + '**'],
              priority: 'extension',
              canOpen: (address) => sessionOfAddress(address) !== undefined,
              title: (address) => {
                const sessionId = sessionOfAddress(address)
                return (sessionId === undefined ? undefined : pendingTitles.get(sessionId)) ?? '侧聊'
              },
            }),
          'side-chat: tab type',
        )

        scope.effect(
          () =>
            scope.slots.inject('sidebar.right.pane.tab', () =>
              scope.slots.register(
                {
                  name: 'sidebar.right.pane.tab',
                  key: PLUGIN_ID,
                  children: { 'sidebar.chat.conversation': { kind: 'single', scope: 'session' } },
                },
                SideChatTab,
              ),
            ),
          'side-chat: tab body',
        )
      })

      // 关闭（显式关闭或替换）→ 归档；折叠、切会话、插件卸载不触发
      ctx.inject(['sidebarRight'], (scope) => {
        scope.effect(
          () =>
            scope.sidebarRight.registerCloseHandler(KIND, (_hostSessionId, tab) => {
              const childId = sessionOfAddress(tab.contentId)
              if (childId === undefined) return
              void archiveSideChat(ctx, childId)
            }),
          'side-chat: close to archive',
        )
      })

      // Ctrl+Alt+S
      ctx.inject(['shortcuts', 'sidebarRight'], (scope) => {
        scope.effect(
          () =>
            scope.shortcuts.register({
              id: 'sidechat.open',
              label: () => '打开侧边会话',
              aliases: ['side chat', '侧边会话', '侧聊'],
              defaults: {
                'desktop:macos': { code: 'KeyS', modifiers: ['primary', 'alt'] },
                'desktop:windows': { code: 'KeyS', modifiers: ['primary', 'alt'] },
                'desktop:linux': { code: 'KeyS', modifiers: ['primary', 'alt'] },
                'web:macos': { code: 'KeyS', modifiers: ['primary', 'alt'] },
                'web:windows': { code: 'KeyS', modifiers: ['primary', 'alt'] },
              },
              regions: ['page', 'editable', 'terminal'],
              modals: [],
              resolve: () => {
                const parentId = scope.sidebarRight.mounted.getSnapshot()
                if (parentId === undefined) return { status: 'blocked', reason: '先打开一个会话' }
                return {
                  status: 'handled',
                  run: () => {
                    void openSideChat(ctx, parentId)
                  },
                }
              },
            }),
          'side-chat: shortcut',
        )
      })
    }

    return { inject, apply }
  },
})
