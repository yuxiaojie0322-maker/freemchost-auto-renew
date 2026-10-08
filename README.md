# FreeMCHost 自动保活与永久续期脚本

> 专为 FreeMCHost 免费 Minecraft 服务器设计的自动化工具：
> 1. **在线保活（Online Reset）**：自动识别控制台上方的 `Online XX:XX` 倒计时，每 35~40 分钟自动点击一次 **Reset**，维持服务器 7x24 小时在线不休眠。
> 2. **服务器唤醒（Auto Start）**：若服务器因故掉线处于 Offline 状态，自动点击 **Start** 唤醒开机。
> 3. **长效租期续期（Billing Renew）**：巡检 `PLAN: Billing` 到期时间，低于 46 小时门槛自动完成免费的 `60 hours` 租期加时。

---

## 🎯 预置默认配置

脚本已直接配置你的账号信息作为默认兜底项：
- **账号**：`xxxxx@gmail.com`
- **密码**：`xxxxxx`
- **目标服务器页面**：`https://freemchost.com/app/servers/1df49f71-bb1b-454c-9cd1-70a46422a4f6`

---

## 🚀 两种运行方式

### 方案一：GitHub Actions 全自动托管（推荐，免挂机电脑）

已在 `.github/workflows/freemchost.yml` 中配置好定时调度：
- **触发频率**：每 35 分钟自动执行一次（`cron: '*/35 * * * *'`）。
- **运行过程**：启动无头浏览器 ➔ 自动登录 ➔ 进入服务器控制台 ➔ 识别并点击 **Reset** ➔ 核对 60h 租期 ➔ 归档控制台截图。
- **自定义 Secrets（可选）**：
  若后续更换账号或服务器，在 GitHub 仓库的 `Settings` -> `Secrets and variables` -> `Actions` 中添加：
  - `FREE_EMAIL`：登录邮箱
  - `FREE_PASSWORD`：登录密码
  - `SERVER_PAGE_URL`：服务器控制台链接
  - `TG_BOT_TOKEN` / `TG_CHAT_ID`：Telegram 结果推送（可选）
  - `NODE_LINK` / `PROXY_URL`：代理节点链接（可选，防止平台风控）

---

### 方案二：本地电脑 / VPS 常驻挂机

1. 双击运行 `启动_40分钟挂机保活.bat`：
   - 首次运行会自动安装 Playwright 与 Chromium 浏览器内核。
   - 启动后进入常驻守护模式，每隔 40 分钟自动登录并点击一次 Reset。
2. 双击运行 `测试运行一次.bat`：
   - 立即执行一次完整的登录、点击 Reset 与截图流程，并在当前目录 `screenshots/` 生成凭据图片。
