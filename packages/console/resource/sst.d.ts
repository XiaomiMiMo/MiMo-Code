/* sst 类型 shim:本仓已从 devDependencies 移除 sst(其依赖 opencontrol@0.0.6 npm 元数据无
 * license 字段;且本仓不部署上游 opencode 的云设施,sst.config.ts / infra/ 从未在 fork 启用)。
 * 上游 console 链路文件(resource.node.ts / drizzle.config.ts / function/api.ts)仍 import "sst"
 * 取 Resource,此处以宽松类型代替包内类型,让 typecheck 不依赖 sst 安装;这些代码路径在本仓
 * 不会运行(部署入口已随 sst 移除)。若未来真要部署,装回 sst 并删除本 shim 即可。 */
declare module "sst" {
  export const Resource: Record<string, any>
}
