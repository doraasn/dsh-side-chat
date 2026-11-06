# 变更记录

对外包名 `dsh-side-chat-panel`（仓库 `doraasn/dsh-side-chat`，开发身份 `@local/dsh-side-chat`）。
索引固定 pin 到 `vX.Y.Z` tag 的 commit，展示文案由 `dsh-plugins-index` 维护。

## 0.1.6

- 修：侧聊改名一直"成功"但写进去的是光秃秃的 `侧聊`。父会话标题原来只读
  `list.byId[id].projections.values.title` 一条路，读不到就退化成常量。
- 改为四级回退：绑定会话投影 `face('title')` → `list.projectionsBySession[id]` →
  `byId` hints → fork 继承的子会话标题；四级全空时**不改名**，保留继承标题，不再写空值。

## 0.1.5

- 同 0.1.6 的标题修复（先行版），已由 0.1.6 取代。

## 0.1.4

- 换用统一规格图标（36×36、官方蓝渐变、气泡 + 左侧栏条），随 tag 带出。

## 0.1.3

- 修：tab 标题在打开瞬间取不到会话投影 → 标题编进资源地址（`?t=<标题>`），打开即用。
- 新增：在左侧会话树归档侧聊会话时，右栏对应 tab 自动关闭（订阅 `archivedSessionIds`）。

## 0.1.2

- 修：改走 `sessions.using(...).binding.session.rename()`，并检查 `RemoteResult.ok`；
  裸 Remote 的业务失败是 resolve 的 `ok:false`，原来被静默当成成功。

## 0.1.1

- 修：对话体不再复用 `ui-subagent` 的 `sidebar.chat.conversation`（该槽声明期绑在它的 tab
  entry 上，跨插件渲染为空面板），改为自带 `sidechat.chat` 槽 + 自带对话体。

## 0.1.0

- 首版：`Ctrl+Alt+S` 从当前会话 fork 到右栏，继承最近已完成轮次上下文，关闭即归档。

## 踩过的坑（写给后续维护者）

1. **改名失败要把原因记进日志，不要静默写空值。** 这轮排查的第一条线索就是日志里"写进去的是
   `侧聊`"，而不是"没改名"——两者根因完全不同。
2. 业务失败不是异常：Remote 返回 `RemoteResult`，`await` 不会抛，必须显式判 `ok`。
3. 槽位有声明归属：`declaredBy` 指向某个 entry 的槽，跨插件当子槽用会渲染成空。
