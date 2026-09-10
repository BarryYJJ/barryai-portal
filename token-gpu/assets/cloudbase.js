// CloudBase SDK 加载 + 初始化（与 briefs / openrouter 站点保持同一套加载方式）
// 这是本页唯一的远程脚本，只服务访问闸门；图表数据仍来自同目录的 data/dashboard.json。
const ENV_ID = 'sellside-notes-d4g7x34ag33997bb9';

window.cbReady = new Promise((resolve, reject) => {
  const s = document.createElement('script');
  s.src = 'https://static.cloudbase.net/cloudbase-js-sdk/2.27.1/cloudbase.full.js';
  s.onload = async () => {
    try {
      const cb = cloudbase.init({ env: ENV_ID });
      // 匿名登录（CloudBase 调函数需要 auth state）
      await cb.auth({ persistence: 'local' }).signInAnonymously();
      resolve(cb);
    } catch (e) {
      reject(e);
    }
  };
  s.onerror = () => reject(new Error('CloudBase SDK 加载失败'));
  document.head.appendChild(s);
});
