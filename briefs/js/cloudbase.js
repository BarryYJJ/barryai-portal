// CloudBase SDK 加载 + 初始化
// sellside-notes-d4g7x34ag33997bb9 由 deploy 脚本替换为实际环境 ID
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
