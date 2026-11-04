# dsh-side-chat

DSH 侧边会话：`Ctrl+Alt+S` 从当前会话分叉一份上下文，在右栏开一个独立对话；关掉标签即归档。

## 行为

| 项 | 说明 |
|---|---|
| 快捷键 | `Ctrl+Alt+S`（macOS 为 `Cmd+Alt+S`）。焦点在输入框、终端里也能用 |
| 上下文 | 宿主 `session/fork`，切到**最近已完成轮次**的事件的精确前缀；是快照，不与父会话活共享 |
| 模型 | **有条件继承**：父会话的选择与全局默认不同时，fork 后补一次 `selectModel`；相同则不写，避免把默认模型改脏 |
| 多个 | 每按一次就是一个独立 fork，各自一份上下文、各自计费，不设上限 |
| 标题 | `侧聊·<父会话标题>`，同时写入会话标题，方便在「已归档」里辨认 |
| 关闭 | 停止仍在跑的工作并**归档**（DSH 没有会话删除接口）。归档行在侧栏「全部对话（显示已归档）」里可恢复 |

## 实现要点

- 右栏 tab 走公开扩展点：`ctx.sidebarRightTabs.register` + `ctx.resources.register`，地址是 `dsh-resource://sidechat/session/<sessionId>`。
- 对话内容复用 `sidebar.chat.conversation` 槽（由 `@deepseek-ai/dsh-client-ui-subagent` 提供，子代理侧聊用的也是它），不重写聊天 UI。
- 资源释放靠 `resources` 的 abort 信号：最后一个订阅者离开即 `reference.release()`。
- 关闭钩子 `registerCloseHandler` 只在显式关闭/替换时触发，折叠右栏、切会话、插件卸载都不会归档。

## 已知限制

- 关闭后标签从布局里移除，但会话本身留档；下次刷新不会再冒出死标签。
- 若关掉 `@deepseek-ai/dsh-client-ui-subagent`，本插件的面板会没有内容（聊天 UI 是它提供的）。
- 改动了宿主侧的 bundle 列表，**需要重启 DSH** 才会加载。

## 开发

```bash
npm test                                              # 假的 ctx + 最小 React，跑注册面/快捷键/fork/归档/资源流
node <skill>/scripts/check-plugin.mjs .                # 身份、图标、元数据自检
```

## 发布

- 仓库：`doraasn/dsh-side-chat`；main 保留开发身份 `@local/dsh-side-chat`，tag `v0.1.0` 指向发布身份快照。
- **对外包名是 `dsh-side-chat-panel`**：npm 上的 `dsh-side-chat` 已被他人占用（0.1.0~0.1.2），若沿用原名，市场索引会把条目指到别人的 npm 包，`npmHas()` 判真后 `source.type` 变成 `npm`。
- 已收录进 `doraasn/dsh-plugins-index`（category `chat`，labels `sidebar`/`no-deps`）。
