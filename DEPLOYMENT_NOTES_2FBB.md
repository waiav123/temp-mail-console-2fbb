# 2fbb 实例说明

## 当前实例

- Worker：`temp-mail-console-2fbb`
- 管理地址：`https://temp-mail-console-2fbb.youtubex.workers.dev/`
- 邮件域名：`2fbb.com`
- 本地仓库：`C:\Users\Administrator\Desktop\code\CloudflareMail\temp-mail-console-2fbb`

## 当前线上行为

- `*@2fbb.com` 收信正常。
- 当前白名单为空，因此所有发件域名都可进入解析流程。
- 当前 4 条默认规则全部启用，且 `sender_filter` 全部为空。
- 这意味着：任何发件域名发来的邮件，只要成功投递到 Worker，都会尝试提取验证码。
- 当前 API `/api/emails/latest` 会返回：
  - `primary_result`
  - `results`
- 当前 `results` 默认只保留最优 1 条结果。

## 当前默认提取能力

- 6 位纯数字
- 8 位纯数字
- 6 到 8 位字母数字混合码
- URL

并且当前正文预处理已经增强为：

- `postal-mime + cheerio + html-to-text + he + email-reply-parser + libphonenumber-js + get-urls + tldts`
- HTML 会先做 DOM 预清洗，再转文本
- 回复链、签名、footer、tracking 块会尽量在匹配前剔除
- 支持电话类数字噪音会尽量在匹配前剔除
- 被拆散的验证码片段会先尝试归并

并且已经上线这些排序增强：

- 同一条规则遍历全部命中，不再只取第一个命中。
- 如果正则用了捕获组，优先返回第一个非空捕获组。
- 上下文中靠近 `验证码`、`code`、`verify`、`otp` 的候选值优先。
- 靠近 `订单`、`金额`、`price`、`support` 等噪音词的候选值会降权。

## 调试正文策略

- 不再永久保存所有邮件正文。
- 当前采用“最近 N 天正文调试存储”。
- 默认保留：`2` 天。
- 环境变量：`DEBUG_BODY_RETENTION_DAYS`
- 管理后台支持直接查看：
  - `text_content`
  - `html_content`
  - `normalized_text`
  - `ranked_urls`

## 已验证过的发件来源示例

这些发件来源已经在线上真实收信并提取成功：

- `otp@tm1.openai.com`
- `cceshi950@gmail.com`
- `waiav@qq.com`
- `admin@accgo.shop`

## 最近完成的关键提交

- `8b367c8` Improve email extraction preprocessing
- `7940aeb` Retain debug email bodies for N days
- `03df971` Prioritize primary verification code extraction
- `cb15900` Normalize extracted matches on read
- `841dedc` Improve verification code match ranking

## 发布方式

- 本机 `wrangler` 当前未登录。
- 线上发布通过 GitHub push 触发 Cloudflare Workers Builds 自动构建。
- 文档更新时间之后的最新功能，应以 `main` 分支和最近一次成功的 Cloudflare build 为准。
- 当前 `wrangler.toml` 已启用 `compatibility_flags = ["nodejs_compat"]`，因为 `email-reply-parser` 依赖该兼容层。
