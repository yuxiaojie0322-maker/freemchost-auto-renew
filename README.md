# FreeMCHost 自动保活与永久续期

> 专为 FreeMCHost 免费 Minecraft 服务器设计的自动化工具：
> 1. **在线保活（Online Reset）**：自动识别控制台上方的 `Online XX:XX` 倒计时，每 35~40 分钟自动点击一次 **Reset**，维持服务器 7x24 小时在线不休眠。
> 2. **服务器唤醒（Auto Start）**：若服务器因故掉线处于 Offline 状态，自动点击 **Start** 唤醒开机。
> 3. **长效租期续期（Billing Renew）**：巡检 `PLAN: Billing` 到期时间，低于 46 小时门槛自动完成免费的 `60 hours` 租期加时。

---

## 🔒 架构说明与安全保护

本项目采用模块化安全管理架构：
- **触发与工作流调度**：托管于当前公开仓库（仅保留 Actions 配置与执行日志），免去暴露核心代码与逻辑。
- **核心自动化逻辑**：托管于私有仓库 `my-private-scripts/freemchost`。
- **认证配置**：通过 GitHub Actions Secrets 安全注入，无需任何明文凭证。

---

## 🚀 运行方式

### GitHub Actions 全自动托管

已在 `.github/workflows/freemchost.yml` 中配置自动化执行支持：
- **触发机制**：支持手动 `workflow_dispatch` 触发，或由外部白虎面板定时触发，防排队调度延迟。
- **自定义 Secrets**：
  若后续更换账号或服务器，在当前仓库 `Settings` -> `Secrets and variables` -> `Actions` 中配置：
  - `FREE_EMAIL`：登录邮箱
  - `FREE_PASSWORD`：登录密码
  - `SERVER_PAGE_URL`：服务器控制台链接
  - `CORE_SCRIPT_TOKEN`：私有脚本库拉取访问 Token
  - `TG_BOT_TOKEN` / `TG_CHAT_ID`：Telegram 结果推送（可选）
  - `NODE_LINK` / `PROXY_URL`：代理节点链接（可选）
