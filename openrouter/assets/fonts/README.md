# 自托管字体

## montserrat-latin-variable.woff2

- 字体：Montserrat（可变字重 `wght` 100–900，normal 字形）
- 版本：Version 9.000（Google Fonts 切片 v31）
- 子集：**latin**（仅拉丁字符，232 个码位；不含 CJK）
- 授权：SIL Open Font License 1.1，全文见 `OFL.txt`
- 上游：<https://fonts.gstatic.com/s/montserrat/v31/JTUSjIg1_i6t8kCHKm459WlhyyTh89Y.woff2>
  （由 `https://fonts.googleapis.com/css2?family=Montserrat:wght@100..900&display=swap` 的 latin 分片解析得到）

该文件已随仓库自托管，页面运行时**不请求任何 CDN**。

因为只包含拉丁子集，`@font-face` 的 `unicode-range` 相应只声明拉丁码位：
中文字符不会命中 Montserrat，会按字体栈自然回落到 PingFang SC。

### 更新方式

```bash
curl -sS -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" \
  "https://fonts.googleapis.com/css2?family=Montserrat:wght@100..900&display=swap"
# 取其中 /* latin */ 分片的 src URL 与 unicode-range，下载覆盖本目录的 woff2，
# 并同步更新 dashboard/public/css/style.css、脚本/周报模板.html 里的 unicode-range。
```
