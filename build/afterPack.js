'use strict';
/**
 * 打包后处理：只保留需要的 Electron 语言包，省 ~45MB。
 * 其它语言的 .pak 删掉不影响界面（界面语言由系统语言决定，缺了会回退到 en-US）。
 */
const fs = require('fs');
const path = require('path');

module.exports = async function afterPack(context) {
  const locales = path.join(context.appOutDir, 'locales');
  if (!fs.existsSync(locales)) return;
  const keep = /^(en-US|zh-CN|zh-TW)\.pak$/;
  let removed = 0;
  for (const f of fs.readdirSync(locales)) {
    if (!keep.test(f)) {
      try { fs.unlinkSync(path.join(locales, f)); removed += 1; } catch { /* ignore */ }
    }
  }
  console.log(`  • locales 精简：删掉 ${removed} 个语言包`);
};
