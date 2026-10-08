const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Telegram 消息与截图推送
async function sendTG(botToken, chatId, text, photoPath) {
  if (!botToken || !chatId) return;
  try {
    if (photoPath && fs.existsSync(photoPath)) {
      try {
        const fileBuffer = fs.readFileSync(photoPath);
        const blob = new Blob([fileBuffer], { type: 'image/png' });
        const formData = new FormData();
        formData.append('chat_id', chatId);
        formData.append('caption', text.substring(0, 1024));
        formData.append('parse_mode', 'HTML');
        formData.append('photo', blob, path.basename(photoPath));

        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
          method: 'POST',
          body: formData
        });

        if (res.ok) {
          console.log('📨 Telegram 截图与图文报告推送成功！');
          return;
        } else {
          const errData = await res.text();
          console.log(`⚠️ sendPhoto 接口返回错误 (${errData})，自动回退到纯文本推送...`);
        }
      } catch (err) {
        console.log(`⚠️ 发送图片过程异常 (${err.message})，自动回退到纯文本推送...`);
      }
    }

    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
    console.log('📨 Telegram 纯文本推送成功');
  } catch (e) {
    console.log('⚠️ Telegram 推送失败:', e.message);
  }
}

// 快速关闭外部干扰弹窗（关闭 Cookie 授权、Feedback 评分面板，绝不影响正常续期与开机操作）
async function cleanPopup(page) {
  try {
    await page.evaluate(() => {
      // 1. 关闭 Cookie 授权
      const allBtns = Array.from(document.querySelectorAll('button, a, div[role="button"], span'));
      const cookieBtn = allBtns.find(b => {
        const t = (b.innerText || b.textContent || '').trim().toLowerCase();
        return t === 'accept all' || t === 'accept';
      });
      if (cookieBtn) cookieBtn.click();

      // 2. 仅针对评价/打分 (Feedback / How are you enjoying) 的弹窗做安全关闭或移除，严禁误触续期及正常业务操作
      const allDialogs = Array.from(document.querySelectorAll('div, section, aside, [role="dialog"]'));
      for (const el of allDialogs) {
        const t = (el.innerText || '').toLowerCase();
        const isFeedback = t.includes('how are you enjoying') || t.includes('feedback') || t.includes('rate your experience');
        const isBusiness = t.includes('keep your server online') || t.includes('time until expiry') || t.includes('start server') || t.includes('60 hour') || t.includes('billing');

        if (isFeedback && !isBusiness) {
          const subBtns = Array.from(el.querySelectorAll('button, a, span'));
          const closeBtn = subBtns.find(b => {
            const bt = (b.innerText || b.textContent || '').trim().toLowerCase();
            return bt === 'maybe later' || bt === 'not now' || bt === 'dismiss' || bt === 'close';
          });
          if (closeBtn) {
            closeBtn.click();
          } else {
            el.remove();
          }
        }
      }
    });
  } catch (_) {}
}


// 容错与恢复：处理 FreeMCHost 偶发页面崩溃或客户端路由错误 (This page didn't load)
async function recoverIfPageCrashed(page, fallbackUrl = '') {
  try {
    const isCrashed = await page.evaluate(() => {
      const t = (document.body ? document.body.innerText : '').toLowerCase();
      return t.includes("this page didn't load") || t.includes("something went wrong on our end");
    }).catch(() => false);

    if (isCrashed) {
      console.log('⚠️ 检测到页面异常 (This page didn\'t load)，正在尝试恢复...');
      const tryAgainBtn = page.locator('button:has-text("Try again"), a:has-text("Try again")').first();
      if (await tryAgainBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await tryAgainBtn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(3000);
      } else if (fallbackUrl) {
        await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);
      }
      await cleanPopup(page);
    }
  } catch (_) {}
}

// 核心功能：检查控制台运行状态、在线时长与资源占用
async function handleServerStateAndReset(page) {
  console.log('🔍 正在检测控制台运行状态与服务器指标...');

  try {
    const consoleTab = page.locator('button:has-text("Console"), [role="tab"]:has-text("Console"), a:has-text("Console")').first();
    if (await consoleTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await consoleTab.click({ force: true }).catch(() => {});
      await page.waitForTimeout(800);
    }
  } catch (e) {}

  await cleanPopup(page);

  const stateInfo = await page.evaluate(() => {
    const clone = document.body ? document.body.cloneNode(true) : document.createElement('div');
    const logs = clone.querySelectorAll('.xterm, [class*="terminal"], [class*="console-log"], pre, code');
    logs.forEach(el => el.remove());
    const cleanText = clone.innerText || '';

    const queueMatch = cleanText.match(/You're in the queue for Free[\s\S]*?Position #?(\d+)\s+of\s+(\d+)/i) ||
                       cleanText.match(/Position #?(\d+)\s+of\s+(\d+)/i);
    const inQueue = Boolean(queueMatch);

    const allButtons = Array.from(document.querySelectorAll('button'));
    const hasStartBtn = allButtons.some(b => {
      const t = (b.innerText || b.getAttribute('aria-label') || '').toLowerCase();
      return t === 'start' || (t.includes('start') && !t.includes('restart'));
    });
    const isOffline = (/Offline/i.test(cleanText) || cleanText.includes('Server is offline')) && hasStartBtn;

    // 提取在线时长与资源
    const uptimeMatch = cleanText.match(/Up\s*(\d+[dhm\s\d]+)/i);
    const uptimeStr = uptimeMatch ? uptimeMatch[1].trim() : null;

    const cpuMatch = cleanText.match(/CPU[\s\S]*?(\d+(?:\.\d+)?%)/i);
    const memMatch = cleanText.match(/Memory[\s\S]*?(\d+(?:\.\d+)?\s*(?:MB|GB))/i);
    const resSummary = [cpuMatch ? `CPU ${cpuMatch[1]}` : '', memMatch ? `内存 ${memMatch[1]}` : ''].filter(Boolean).join(' | ');

    return {
      inQueue,
      queuePos: queueMatch ? `Position #${queueMatch[1]} of ${queueMatch[2]}` : (inQueue ? '排队中' : null),
      isOffline,
      uptimeStr,
      resSummary
    };
  });

  if (stateInfo.inQueue) {
    return { statusType: 'queue', success: true, isOffline: false, inQueue: true, message: `排队等待启动 (${stateInfo.queuePos || '排队中'})` };
  }

  let statusText = '🟢 Running (正常运行)';
  if (stateInfo.isOffline) {
    statusText = '🔴 Offline (已关机/离线)';
  } else {
    if (stateInfo.uptimeStr) {
      const formattedUp = stateInfo.uptimeStr.replace(/\s+/g, ' ').replace('h', '小时').replace('m', '分').replace('d', '天');
      statusText += ` · 在线 ${formattedUp}`;
    }
    if (stateInfo.resSummary) {
      statusText += ` · ${stateInfo.resSummary}`;
    }
  }

  console.log(`✅ 运行状态: ${statusText}`);
  return { statusType: stateInfo.isOffline ? 'offline' : 'online', success: true, isOffline: stateInfo.isOffline, inQueue: false, message: statusText };
}

// 核心功能：开机保活（点击控制台启动 Play ▷ 按钮 -> 点击 Standard start 选项卡，支持 3 小时间隔控制）
async function checkAndTriggerStartKeepalive(page, isOffline = false) {
  const intervalHours = parseFloat(process.env.START_INTERVAL_HOURS || '3'); // 默认 3 小时
  const recordFile = path.join(process.cwd(), 'last_start.json');

  let lastStartTime = 0;
  try {
    if (fs.existsSync(recordFile)) {
      const data = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
      lastStartTime = data.lastStartTimestamp || 0;
    }
  } catch (_) {}

  const now = Date.now();
  const diffHours = lastStartTime > 0 ? (now - lastStartTime) / (1000 * 3600) : 999;
  const forceStart = process.env.FORCE_START === 'true';
  const shouldStart = forceStart || isOffline || diffHours >= intervalHours;

  console.log(`⏱️ 距离上次执行开机保活: ${lastStartTime > 0 ? diffHours.toFixed(2) + ' 小时' : '无历史记录'} (设定周期: ${intervalHours} 小时)`);

  if (!shouldStart) {
    console.log(`☕ 距离上次启动仅 ${diffHours.toFixed(1)}h，未满 ${intervalHours}h 设定间隔，本次跳过开机动作`);
    return { executed: false, message: `跳过 (上次于 ${diffHours.toFixed(1)}h 前启动，设定每 ${intervalHours}h 一次)` };
  }

  console.log(isOffline ? '⚡ 检测到服务器处于离线状态，立即触发开机唤醒...' : `🚀 达到 ${intervalHours} 小时保活周期，准备执行开机保活 (Standard start)...`);

  try {
    // 确保处于 Console 控制台标签页
    const consoleTab = page.locator('button:has-text("Console"), [role="tab"]:has-text("Console"), a:has-text("Console")').first();
    if (await consoleTab.isVisible({ timeout: 1500 }).catch(() => false)) {
      await consoleTab.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1000);
    }

    // 1. 定位控制台上方的启动按钮 (Play ▷ / polygon 图标 / Start)
    console.log('🔍 正在定位控制台上方的 Play (▷) 启动按钮...');
    const playClicked = await page.evaluate(() => {
      const allBtns = Array.from(document.querySelectorAll('button'));
      const startBtn = allBtns.find(b => {
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        const text = (b.innerText || '').trim().toLowerCase();
        if (aria === 'start' || text === 'start' || aria === 'play' || text === 'play') return true;
        const svg = b.querySelector('svg');
        if (svg) {
          if (svg.classList.contains('lucide-play') || svg.querySelector('polygon')) return true;
        }
        return false;
      });

      if (startBtn) {
        startBtn.scrollIntoView({ block: 'center' });
        startBtn.click();
        return true;
      }
      return false;
    });

    if (!playClicked) {
      const startLoc = page.locator('button:has(polygon), button:has(svg.lucide-play), button[aria-label="Start"], button[aria-label="Play"]').first();
      if (await startLoc.isVisible({ timeout: 2500 }).catch(() => false)) {
        await startLoc.click({ force: true });
      } else {
        console.log('⚠️ 未在控制台找到启动 (Play ▷) 按钮');
        return { executed: false, message: '未找到启动 (Play ▷) 按钮' };
      }
    }

    // 2. 等待 Start server 选项弹窗加载
    console.log('⏳ 等待【Start server】选项弹窗加载...');
    const modalVisible = await page.waitForFunction(() => {
      const t = (document.body.innerText || '').toLowerCase();
      return t.includes('start server') && t.includes('standard start');
    }, { timeout: 8000 }).catch(() => false);

    if (!modalVisible) {
      console.log('⚠️ 未检测到【Start server】弹窗，可能已直接处于运行中');
      return { executed: false, message: '已点击启动 (未出现选项弹窗)' };
    }

    await page.waitForTimeout(1000);

    // 3. 点击【Standard start】选项卡
    console.log('👆 正在定位并点击【Standard start】启动选项卡...');
    const stdResult = await page.evaluate(() => {
      const modal = Array.from(document.querySelectorAll('*')).find(el => {
        const t = (el.innerText || '').toLowerCase();
        return t.includes('start server') && t.includes('standard start') && el.children.length > 1;
      });
      if (!modal) return null;

      const candidates = Array.from(modal.querySelectorAll('*')).filter(el => {
        const t = (el.innerText || el.textContent || '').trim();
        return t.includes('Standard start') && !t.includes('Boosted');
      });

      let targetCard = null;
      for (const el of candidates) {
        const r = el.getBoundingClientRect();
        if (r.width > 120 && r.height > 30) {
          targetCard = el;
          break;
        }
      }
      if (!targetCard && candidates.length > 0) targetCard = candidates[0];

      if (targetCard) {
        targetCard.scrollIntoView({ block: 'center' });
        const rect = targetCard.getBoundingClientRect();
        return {
          success: true,
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2)
        };
      }
      return null;
    });

    if (stdResult && stdResult.success) {
      console.log(`👆 点击【Standard start】启动选项卡 (${stdResult.x}, ${stdResult.y})...`);
      await page.mouse.click(stdResult.x, stdResult.y);
    } else {
      const stdLoc = page.locator('div, button, a').filter({ hasText: 'Standard start' }).last();
      if (await stdLoc.isVisible({ timeout: 1500 }).catch(() => false)) {
        await stdLoc.click({ force: true }).catch(() => {});
      }
    }

    console.log('🎉 已触发【Standard start】开机保活！等待弹窗关闭...');
    await page.waitForTimeout(3000);
    await cleanPopup(page);

    // 4. 更新上次启动时间记录
    try {
      const recordData = {
        lastStartTimestamp: Date.now(),
        lastStartTimeStr: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
      };
      fs.writeFileSync(recordFile, JSON.stringify(recordData, null, 2));
      console.log(`💾 已保存开机保活记录: ${recordData.lastStartTimeStr}`);
    } catch (_) {}

    return { executed: true, message: `已成功执行 Standard start 开机保活 (周期: 每 ${intervalHours}h)` };
  } catch (e) {
    console.log(`⚠️ 开机保活执行异常: ${e.message}`);
    return { executed: false, message: `开机保活异常: ${e.message}` };
  }
}

// 严谨提取 Plan Billing 页面中的到期时间（必须在 TIME UNTIL EXPIRY 容器内匹配，严禁误读 Console 的 Up 5h 18m）
async function extractExpiryTime(page) {
  return await page.evaluate(() => {
    const allEls = Array.from(document.querySelectorAll('*'));
    const expiryHeader = allEls.find(el => {
      const t = (el.textContent || '').trim().toUpperCase();
      return t === 'TIME UNTIL EXPIRY' || t.startsWith('TIME UNTIL EXPIRY') || t.includes('EXPIRES IN');
    });

    // 严禁在非 Billing 页面或未找到倒计时标题时提取，防止误读控制台运行时间！
    if (!expiryHeader) {
      return null;
    }

    let p = expiryHeader.parentElement;
    let targetText = '';
    for (let i = 0; i < 4 && p; i++) {
      targetText += ' ' + (p.innerText || '');
      p = p.parentElement;
    }
    const clean = targetText.replace(/[\r\n\t]+/g, ' ');

    // 格式 1: 01 10 37 39 或 1D 10H 37M
    const mDigits = clean.match(/TIME UNTIL EXPIRY[\s\S]*?(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})/i);
    if (mDigits) {
      const d = parseInt(mDigits[1], 10);
      const h = parseInt(mDigits[2], 10);
      const min = parseInt(mDigits[3], 10);
      return { totalHours: d * 24 + h + min / 60, raw: `${d}天${h}小时${min}分` };
    }

    const mFull = clean.match(/(\d{1,3})\s*D(?:AYS?)?[\s\S]*?(\d{1,2})\s*H(?:OURS?)?[\s\S]*?(\d{1,2})\s*M(?:INUTES?)?/i);
    if (mFull) {
      const d = parseInt(mFull[1], 10);
      const h = parseInt(mFull[2], 10);
      const min = parseInt(mFull[3], 10);
      return { totalHours: d * 24 + h + min / 60, raw: `${d}天${h}小时${min}分` };
    }

    // 格式 2: 仅包含 天、时
    const mDH = clean.match(/(\d{1,3})\s*D(?:AYS?)?[\s\S]*?(\d{1,2})\s*H(?:OURS?)?/i);
    if (mDH) {
      const d = parseInt(mDH[1], 10);
      const h = parseInt(mDH[2], 10);
      return { totalHours: d * 24 + h, raw: `${d}天${h}小时` };
    }

    // 格式 3: 仅包含 时、分 (不足 1 天)
    const mHM = clean.match(/(\d{1,2})\s*H(?:OURS?)?[\s\S]*?(\d{1,2})\s*M(?:INUTES?)?/i);
    if (mHM) {
      const h = parseInt(mHM[1], 10);
      const min = parseInt(mHM[2], 10);
      return { totalHours: h + min / 60, raw: `0天${h}小时${min}分` };
    }

    return null;
  });
}

// 核心功能：切换到 PLAN Billing 核对长效租期（< 46h 执行 60 小时免费续期加时）
async function checkAndRenewBilling(page, fallbackUrl = '') {
  try {
    console.log('👉 正在切换到 PLAN Billing 核对长效租期...');
    await recoverIfPageCrashed(page, fallbackUrl);
    await cleanPopup(page);

    // 1. 定位并点击 PLAN / Billing 标签
    const billingLocators = [
      page.locator('button:has-text("Billing")').first(),
      page.locator('[role="tab"]:has-text("Billing")').first(),
      page.locator('text="Billing"').first(),
      page.locator('button:has-text("PLAN")').first(),
      page.locator('a:has-text("Billing")').first()
    ];

    for (const loc of billingLocators) {
      try {
        if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
          await loc.scrollIntoViewIfNeeded().catch(() => {});
          await loc.click({ force: true });
          break;
        }
      } catch (_) {}
    }

    await page.waitForTimeout(2500);
    await recoverIfPageCrashed(page, fallbackUrl);
    await cleanPopup(page);

    // 2. 提取当前到期剩余时长
    let timeData = await extractExpiryTime(page);
    if (!timeData) {
      await page.waitForTimeout(2000);
      timeData = await extractExpiryTime(page);
    }
    const beforeTime = timeData ? timeData.raw : '未获取到';
    const remainHours = timeData ? timeData.totalHours : 99;
    console.log(`⏱️ 租期剩余时长: ${beforeTime} (约 ${remainHours.toFixed(1)}h)`);

    // 3. 判断是否需要执行 60h 续期加时 (< 46 小时触发加时)
    if (remainHours < 46 && timeData) {
      console.log('🎯 租期 < 46 小时，打开续期面板执行 60h 免费加时...');
      const renewNowBtn = page.locator('button:has-text("Renew now"), [role="button"]:has-text("Renew now")').first();
      if (await renewNowBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await renewNowBtn.scrollIntoViewIfNeeded().catch(() => {});
        await renewNowBtn.click({ force: true });
        console.log('👆 已点击 Renew now 按钮，等待续期面板卡片渲染...');

        // 等待页面中出现 60 hours 相关文本或卡片（不调用 cleanPopup，防止对弹窗产生任何误关/误删）
        const has60Hours = await page.waitForFunction(() => {
          const t = (document.body ? document.body.innerText : '').toLowerCase();
          return (t.includes('60 hour') || t.includes('60h')) || t.includes('keep your server online');
        }, { timeout: 15000 }).catch(() => false);

        if (!has60Hours) {
          console.log('⚠️ 续期面板未在预期时间内渲染完成');
          return { executed: false, status: `剩余 ${beforeTime} (续期面板未弹出)` };
        }

        // 截取弹窗开启后的全景调试快照
        try {
          fs.mkdirSync('screenshots', { recursive: true });
          await page.screenshot({ path: path.join('screenshots', `renew_modal_1_initial.png`) });
        } catch (_) {}

        // 打印弹窗内所有文本与结构
        const dialogInfo = await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"]') || document.querySelector('div.fixed.inset-0') || document.body;
          const buttons = Array.from(dialog.querySelectorAll('button, [role="button"], a')).map(b => ({
            text: (b.innerText || b.textContent || '').trim().replace(/\s+/g, ' '),
            disabled: b.disabled || b.hasAttribute('disabled'),
            tag: b.tagName
          }));
          return {
            fullText: (dialog.innerText || '').slice(0, 1000),
            buttons: buttons
          };
        });
        console.log('📋 续期弹窗文本概览:\n' + dialogInfo.fullText);
        console.log('📋 续期弹窗内按钮列表:', JSON.stringify(dialogInfo.buttons));

        // 向下滚动弹窗以展示所有被遮挡的底部选项
        await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"]') || document.querySelector('div.fixed.inset-0');
          if (dialog) {
            dialog.scrollTop = dialog.scrollHeight;
            const scrollables = dialog.querySelectorAll('*');
            for (const el of scrollables) {
              if (el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
            }
          }
        });
        await page.waitForTimeout(1000);
        try {
          await page.screenshot({ path: path.join('screenshots', `renew_modal_2_scrolled.png`) });
        } catch (_) {}

        // 人性化停留模拟防刷与计时
        console.log('⏳ 停留 4 秒模拟鼠标浏览与防刷等待...');
        for (let sec = 0; sec < 4; sec++) {
          await page.mouse.move(960 + sec * 5, 540 + sec * 3);
          await page.waitForTimeout(1000);
        }

        // 双轨驱动：A 轨通过官方 ServerFn 底层直接安全提交；B 轨通过 UI 按钮交互触发
        const curUrl = page.url();
        const serverIdMatch = curUrl.match(/\/servers\/([a-zA-Z0-9_-]+)/);
        const serverId = serverIdMatch ? serverIdMatch[1] : '';

        let apiRenewDone = false;
        if (serverId) {
          console.log(`🚀 [A轨 - 底层API] 正在调用官方通道执行续期 (Server ID: ${serverId})...`);
          const apiRes = await page.evaluate(async (sId) => {
            try {
              // 自动探查 server.functions 资产模块路径
              const allTags = Array.from(document.querySelectorAll('script[src], link[href]'));
              const targetTag = allTags.find(el => (el.src || el.href || '').includes('server.functions'));
              const scriptUrl = targetTag ? (targetTag.src || targetTag.href) : '/assets/server.functions-CtiXK1PL.js';

              console.log('📥 动态导入官方函数模块:', scriptUrl);
              const mod = await import(scriptUrl);
              if (!mod || !mod.i || !mod.r) {
                return { success: false, reason: '未找到导出函数' };
              }

              // 1. 获取挑战令牌
              console.log('🔑 请求续期挑战令牌...');
              const challenge = await mod.i({ data: { id: sId } });
              console.log('🎯 挑战返回:', JSON.stringify(challenge));

              if (!challenge || !challenge.token) {
                return { success: false, reason: '挑战令牌为空', raw: challenge };
              }

              // 2. 累积停留时间
              const dwell = Math.max(1200, (challenge.min_dwell_ms || 600) + 2000);
              await new Promise(r => setTimeout(r, dwell));

              // 3. 提交续期
              console.log('📤 提交续期加时事务...');
              const renewResult = await mod.r({
                data: {
                  id: sId,
                  token: challenge.token,
                  hp: '',
                  dwell_ms: dwell + 3500
                }
              });

              return { success: true, result: renewResult };
            } catch (err) {
              return { success: false, error: err.message };
            }
          }, serverId);

          console.log('📌 [A轨 - 底层API] 执行结果:', JSON.stringify(apiRes));
          if (apiRes && apiRes.success) {
            apiRenewDone = true;
          }
        }

        // [B轨 - UI交互] 等待按钮解除 disabled 并尝试触发点击
        console.log('👆 [B轨 - UI交互] 检查并触发续期卡片按钮...');
        try {
          // 等待目标按钮解除 disabled 状态
          await page.waitForFunction(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const b = btns.find(x => (x.innerText || '').includes('60 hours') || (x.innerText || '').includes('48 hours'));
            return b && !b.disabled;
          }, { timeout: 3500 }).catch(() => {});

          const freeBtn = page.locator('button').filter({ hasText: /(?:60|48)\s*(?:hours?|h)/i }).last();
          if (await freeBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
            await freeBtn.scrollIntoViewIfNeeded().catch(() => {});
            await freeBtn.click().catch(() => freeBtn.click({ force: true }));
          }
        } catch (_) {}

        await page.waitForTimeout(2000);
        try {
          await page.screenshot({ path: path.join('screenshots', `renew_modal_3_after_click.png`) });
        } catch (_) {}

        // 处理可能弹出的促销弹窗
        const maybeLaterLocator = page.locator('button:has-text("Maybe later"), a:has-text("Maybe later"), [role="button"]:has-text("Maybe later")').first();
        if (await maybeLaterLocator.isVisible({ timeout: 2500 }).catch(() => false)) {
          console.log('👆 检测到 [Upgrade to Free+] 促销弹窗，点击 [Maybe later] 关闭...');
          await maybeLaterLocator.click({ force: true }).catch(() => {});
          await page.waitForTimeout(1500);
        }

        // 保存最终状态快照
        try {
          await page.screenshot({ path: path.join('screenshots', `renew_modal_5_final.png`) });
        } catch (_) {}

        console.log('⏳ 等待续期请求处理与服务端入库 (12 秒)...');
        await page.waitForTimeout(12000);

        // 重新加载页面以刷新最新生命周期
        console.log('🔄 重新加载页面以刷新最新到期时间...');
        await page.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
        await page.waitForTimeout(3000);
        await cleanPopup(page);

        // 切换回 Billing 标签页
        for (const loc of billingLocators) {
          try {
            if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
              await loc.click({ force: true });
              break;
            }
          } catch (_) {}
        }
        await page.waitForTimeout(3000);
        await cleanPopup(page);

        // 提取最新到期时间
        const newTimeData = await extractExpiryTime(page);
        const afterHours = newTimeData ? newTimeData.totalHours : remainHours;
        const afterTime = newTimeData ? newTimeData.raw : beforeTime;

        console.log(`⏱️ 续期操作后租期: ${afterTime} (约 ${afterHours.toFixed(1)}h)`);

        if (afterHours > remainHours + 5) {
          console.log(`🎉 续期成功生效！时长由 ${beforeTime} 增加至 ${afterTime}`);
          return { executed: true, status: `已成功续期 (+60h)，现剩余: ${afterTime}` };
        } else {
          console.log(`⚠️ 续期操作后时间未增加: 现为 ${afterTime}`);
          return { executed: false, status: `剩余: ${afterTime} (已触发加时，请核对是否受冷却限制)` };
        }
      } else {
        return { executed: false, status: `剩余 ${beforeTime} (未出现Renew now按钮)` };
      }
    } else {
      return { executed: false, status: `剩余 ${beforeTime} (租期充足无需加时)` };
    }
  } catch (e) {
    console.log(`⚠️ 租期检查过程异常: ${e.message}`);
    return { executed: false, status: `租期检查异常: ${e.message}` };
  }
}

// 登录模块
async function doLogin(page, email, password) {
  console.log('🔑 正在登录 FreeMCHost...');
  await page.goto('https://freemchost.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1500);
  await cleanPopup(page);

  if (!page.url().includes('/login')) {
    console.log('✅ 已处于登录状态');
    return;
  }

  const emailInput = page.locator('input[type="email"]').first();
  await emailInput.waitFor({ state: 'visible', timeout: 15000 });
  await emailInput.click();
  await emailInput.fill(email);

  const passInput = page.locator('input[type="password"]').first();
  await passInput.click();
  await passInput.fill(password);
  await page.waitForTimeout(300);

  const signInBtn = page.locator('button[type="submit"]:has-text("Sign in")').first();
  await signInBtn.click();

  let loggedIn = false;
  for (let wait = 0; wait < 20; wait++) {
    await page.waitForTimeout(1000);
    const curUrl = page.url();
    if (!curUrl.includes('/login')) {
      loggedIn = true;
      break;
    }
    await cleanPopup(page);
  }

  if (!loggedIn) {
    throw new Error('登录未成功跳转，请检查账号密码或是否有验证码拦截');
  }
  console.log('🎉 登录成功！');
}

// 执行单次巡检与保活
async function runOnce() {
  const email = (process.env.FREE_EMAIL || 'yuxiaojie0322@gmail.com').trim();
  const password = process.env.FREE_PASSWORD || 'YxJ223512@';
  const rawUrls = (process.env.SERVER_PAGE_URL || 'https://freemchost.com/app/servers/1df49f71-bb1b-454c-9cd1-70a46422a4f6').trim();
  const proxyUrl = (process.env.PROXY_URL || '').trim();
  const tgToken = (process.env.TG_BOT_TOKEN || '').trim();
  const tgChatId = (process.env.TG_CHAT_ID || '').trim();

  const serverUrls = rawUrls.split(/[\r\n,]+/).map(u => u.trim()).filter(u => u.startsWith('http'));
  if (!email || !password || serverUrls.length === 0) {
    console.error('❌ 缺失必要的账号或服务器地址配置');
    return;
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    proxy: proxyUrl ? { server: proxyUrl } : undefined
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  page.on('response', async res => {
    const url = res.url();
    if (url.includes('/api/') || url.includes('renew') || url.includes('server') || url.includes('billing') || url.includes('_serverFn') || url.includes('supabase')) {
      try {
        const status = res.status();
        const text = await res.text();
        console.log(`🌐 [API ${status}] ${url.slice(0, 80)} => ${text.slice(0, 400)}`);
      } catch (_) {}
    }
  });

  let reports = [];
  let finalScreenshot = null;

  try {
    await doLogin(page, email, password);

    for (let i = 0; i < serverUrls.length; i++) {
      const url = serverUrls[i];
      const sIndex = i + 1;
      console.log(`\n================= 正在执行第 [${sIndex}/${serverUrls.length}] 台服务器保活 =================`);

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2500);
      await cleanPopup(page);

      // 1. 控制台状态与在线指标检测
      const resetRes = await handleServerStateAndReset(page);

      // 2. 开机保活（按设定周期，默认 3 小时执行一次 Standard start 启动）
      const startRes = await checkAndTriggerStartKeepalive(page, resetRes.isOffline);

      // 3. Plan 租期核对与 60h 自动加时续期（完成后保持在 Billing 标签页）
      const billRes = await checkAndRenewBilling(page, url);

      // 4. 截取带有 Billing 到期时间的高清特写凭据快照
      try {
        fs.mkdirSync('screenshots', { recursive: true });
        finalScreenshot = path.join('screenshots', `status-${Date.now()}.png`);
        await recoverIfPageCrashed(page, url);
        await cleanPopup(page);

        // 紧凑特写裁切：只保留 TIME UNTIL EXPIRY 倒计时数字方块及 Renews on demand，剔除右侧大片空白与 Renew now 按钮
        const clipArea = await page.evaluate(() => {
          const all = Array.from(document.querySelectorAll('*'));
          const header = all.find(el => {
            const t = (el.textContent || '').trim().toUpperCase();
            return t === 'TIME UNTIL EXPIRY' || t.startsWith('TIME UNTIL EXPIRY');
          });
          if (!header) return null;

          const footer = all.find(el => {
            const t = (el.textContent || '').trim().toLowerCase();
            return t.includes('renews on demand');
          });

          // 寻找包含秒数单位 S 的元素以确定方块右边界
          const sBox = all.find(el => {
            const t = (el.textContent || '').trim();
            return t === 'S' || t === 'SEC';
          });

          const hRect = header.getBoundingClientRect();
          const fRect = footer ? footer.getBoundingClientRect() : null;
          const sRect = sBox ? sBox.getBoundingClientRect() : null;

          const rightEdge = sRect ? (sRect.right + 14) : (hRect.left + 265);
          const bottomEdge = fRect ? (fRect.bottom + 14) : (hRect.top + 130);

          const padding = 14;
          const left = Math.max(0, Math.round(hRect.left - padding));
          const top = Math.max(0, Math.round(hRect.top - padding));
          const width = Math.round(rightEdge - left + padding);
          const height = Math.round(bottomEdge - top);

          return {
            x: left,
            y: top,
            width: Math.max(260, Math.min(320, width)),
            height: Math.max(120, Math.min(160, height))
          };
        });

        if (clipArea) {
          console.log(`📸 正在截取 TIME UNTIL EXPIRY 特写区域:`, JSON.stringify(clipArea));
          await page.screenshot({ path: finalScreenshot, clip: clipArea });
        } else {
          await page.screenshot({ path: finalScreenshot, fullPage: false });
        }
        console.log(`📸 已保存凭据快照: ${finalScreenshot}`);
      } catch (e) {
        console.log(`⚠️ 截图异常: ${e.message}`);
      }

      reports.push(
        `🖥️ <b>服务器 ${sIndex}</b>:\n` +
        `   ⚡ <b>运行状态</b>: ${resetRes.message}\n` +
        `   🚀 <b>开机保活</b>: ${startRes.message}\n` +
        `   📅 <b>长效租期</b>: ${billRes.status}`
      );
    }

    // 格式化输出推送报告
    const nowStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const summary =
      `🤖 <b>FreeMCHost 巡检保活报告</b>\n\n` +
      reports.join('\n\n') + '\n\n' +
      `<b>策略:</b> 控制台在线监测 + 3h开机保活(Standard start) + 46h门槛长效续期(+60h)\n` +
      `<b>完成时间:</b> ` + nowStr;

    // 发送图文报告
    await sendTG(tgToken, tgChatId, summary, finalScreenshot);

  } catch (err) {
    console.error('❌ 执行异常:', err.message);
    try {
      fs.mkdirSync('screenshots', { recursive: true });
      const errShot = path.join('screenshots', `error-${Date.now()}.png`);
      await page.screenshot({ path: errShot });
      await sendTG(tgToken, tgChatId, `⚠️ <b>FreeMCHost 巡检异常</b>:\n${err.message}`, errShot);
    } catch (_) {}
  } finally {
    await browser.close();
    console.log('🏁 本轮保活任务结束\n');
  }
}

// 主入口：支持单次执行（GitHub Actions/Cron）和常驻循环挂机（40分钟/次）
(async () => {
  const isLoop = process.env.LOOP_MODE === 'true' || process.argv.includes('--loop');
  const intervalMinutes = parseInt(process.env.INTERVAL_MINUTES || '40', 10);

  if (isLoop) {
    console.log(`🔄 已开启常驻挂机模式：每隔 ${intervalMinutes} 分钟自动执行一次巡检...`);
    while (true) {
      console.log(`\n[${new Date().toLocaleTimeString()}] 开始执行巡检...`);
      await runOnce();
      console.log(`☕ 本轮完成，挂机休眠 ${intervalMinutes} 分钟...`);
      await new Promise(r => setTimeout(r, intervalMinutes * 60 * 1000));
    }
  } else {
    await runOnce();
  }
})();
