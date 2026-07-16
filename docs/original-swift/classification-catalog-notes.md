# 识别 Catalog 维护说明

## 产品边界

Focus Pet 不尝试理解当前专注任务的语义，也不判断某个 App 是否一定属于当前任务。Catalog 只提供三类粗粒度信号：

- `work`：通常是工作、学习、创作或协作工具。
- `entertainment`：产品文案为“容易分心”，通常是视频流、游戏、社交信息流、购物等高分心场景。
- `ignore`：产品文案为“不参与判断”，包括系统工具、密码管理、启动器、浏览器本体、未知 App 兜底。

`neutral` 只保留给旧数据解码，不能出现在新 catalog、用户选项或默认分类结果里。

## 调研轮次

1. Bundle ID 校验方法：参考 Apple Platform Deployment、Addigy、Jamf/MDM 资料，确认 macOS App 应使用 `CFBundleIdentifier`，并保留 App 名称匹配作为 bundle ID 不稳定或缺失时的兜底。
2. 工作/生产力工具覆盖：按开发工具、办公文档、设计创作、协作会议、任务项目管理等常见桌面工作流扩展。
3. 分心场景覆盖：按视频/直播、短视频、社交信息流、购物、游戏平台和媒体播放器扩展，优先覆盖全球和中文用户常见平台。
4. 参考公开分类清单的类目边界，补充招聘求职、数据分析、身份安全、电商运营、博彩、约会、漫画和休闲论坛等场景；只吸收明确品牌/域名，不整库导入。

## 维护规则

- 用户例外永远优先于 catalog；新增 catalog 项时不要把优先级设置到 10_000 以上。
- 浏览器本体必须是 `ignore`，网站/窗口标题规则优先级必须高于浏览器 App 规则。
- 新增主流 App 时优先使用 bundle ID；没有可靠 bundle ID 时同时加 App 名称。
- 新增网站或浏览器场景时使用 `windowTitle`，并包含品牌名和常见域名。
- 不新增 `neutral` 规则。历史 `.neutral` 在汇总展示时归并为 `ignore`。
- 每次维护后运行：

```bash
jq length Sources/FocusPetCore/Resources/AppClassificationCatalog.json
jq '[.[].patterns | length] | add' Sources/FocusPetCore/Resources/AppClassificationCatalog.json
swift run FocusPetCoreChecks
```

## 当前规模

当前 catalog 有 47 个分组，展开后 1788 条规则：

- `work`：21 组，965 条 pattern
- `entertainment`：20 组，617 条 pattern
- `ignore`：6 组，206 条 pattern
