# barryai.cn

杨浩伟 / Barry Yang 的公开站点，由 GitHub Pages 托管在 <https://barryai.cn/>。

## 这个仓库是什么

**只是一个公开镜像。** 这里所有内容都是从两个 **私有源仓库** 构建后同步过来的，
私有仓库才是 source of truth。不要直接在本仓库手改文件——下一次发布会被
`rsync --delete` 覆盖掉。

| 路径 | 线上地址 | 源仓库（source of truth） | 源目录 |
|---|---|---|---|
| `index.html` | <https://barryai.cn/> | `BarryYJJ/sellside_notes_brief`（私有） | `website/public/portal/index.html` |
| `briefs/` | <https://barryai.cn/briefs/> | `BarryYJJ/sellside_notes_brief`（私有） | `website/public/` |
| `openrouter/` | <https://barryai.cn/openrouter/> | `BarryYJJ/openrouter-data`（私有） | `dashboard/public/` |

旧入口 <https://briefs.barryai.cn>（CloudBase 静态托管）保持可用，与 `/briefs/` 内容一致。
两个站点的表单提交、token 校验、后台列表仍然调用同一套 CloudBase 云函数。

本仓库不包含任何私有项目的代码、原始数据、云函数或运维配置。

## 发布方式

源仓库的 `deploy.sh` 在构建完静态产物后调用本仓库的发布助手：

```bash
scripts/publish-subsite.sh <site-name> <source-dir>
#   site-name  只允许 briefs | openrouter
```

它会：加跨进程锁 → 校验工作树 clean → `git pull --ff-only` →
`rsync --delete`（排除 `.DS_Store` / `.git`）→ 只 `git add` 对应子目录 →
提交 `content(<site>): publish static site` → `git push`。无变化时静默成功，不产生空提交。

常用环境变量：

| 变量 | 作用 |
|---|---|
| `PORTAL_REPO_DIR` | 覆盖 portal 仓库路径（默认取脚本自身所在仓库） |
| `PUBLISH_DRY_RUN=1` | 只同步 + 展示 diff，不 commit/push |
| `PUBLISH_EXTRA_EXCLUDES` | 额外 rsync 排除项，空白分隔 |
| `PUBLISH_LOCK_TIMEOUT` / `PUBLISH_LOCK_STALE` | 锁等待秒数 / 僵死判定秒数 |

## 测试

```bash
bash scripts/run-tests.sh
```

- `scripts/test-publish-subsite.sh` —— 在 `/tmp` 里造 bare remote + clone 跑全套发布助手用例，
  不会碰真实仓库，也不会推送到 GitHub。
- `scripts/test-portal-links.sh` —— 校验 `index.html` 的入口链接指向 `/briefs/` 与 `/openrouter/`。
