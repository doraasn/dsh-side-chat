/**
 * 宿主侧：本插件是纯浏览器侧实现，不需要任何宿主路由或数据采集。
 * 保留 name/apply 以满足 bundle 装载约定；fork 与归档全部走客户端已有服务。
 */
export const name = 'side-chat'

export function apply() {
  // 无宿主侧工作。
}
