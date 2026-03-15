# Temp Mail Console

基于 **Cloudflare Workers + D1** 的临时邮箱控制台。接收邮件后，按可配置规则提取验证码、链接等关键信息，并通过后台和 API 提供查询与调试能力。

## 功能

- 控制台管理：邮件列表、规则管理、白名单管理、调试正文查看。
- 发件人白名单：白名单为空时接收所有发件人；配置后仅处理匹配项。
- 正则提取：支持验证码、数字码、字母数字混合码、链接等内容提取。
- 提取排序：同一封邮件命中多个候选值时，自动选出最优主结果。
- 调试正文：可短期保存最近 N 天的 `text/html/normalized_text/ranked_urls` 用于排查。
- REST API：对外提供最新命中结果查询接口。
- 可选转发：入库后可继续转发原始邮件到真实邮箱。
- 定时清理：Cron 自动删除过期邮件与过期调试正文。

## 当前提取链路

当前 Worker 的正文处理流程如下：

1. 使用 `postal-mime` 解析邮件。
2. 使用 `html-to-text` 将 HTML 转成可读文本。
3. 归一化文本，去除多余空白与重复内容。
4. 使用 `get-urls` 提取链接，再结合 `tldts` 做域名排序。
5. 将提取输入统一改为：

```text
subject + normalized_text + ranked_urls
```

6. 对规则执行全量匹配，不再只看单条规则的第一个命中。
7. 如果规则使用了捕获组，优先返回第一个非空捕获组，而不是整段匹配文本。
8. 按候选值类型、备注关键词、上下文距离、噪音词等因素排序，输出最优结果。

## 快速开始

### 方式一：一键部署

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/beyoug/temp-mail-console)

首次访问后台或首次收到邮件时，Worker 会自动初始化 D1 表结构。

### 方式二：手动部署

#### 1. 安装依赖

```bash
npm install
```

#### 2. 创建 D1 数据库

```bash
npx wrangler d1 create temp-email-db
```

将输出的 `database_id` 写入 `wrangler.toml`。

#### 3. 初始化表结构

```bash
# 本地
npx wrangler d1 execute temp-email-db --local --file=schema.sql

# 远程
npx wrangler d1 execute temp-email-db --file=schema.sql
```

说明：当前版本支持自动建表，上述命令主要用于手动初始化或修复。

#### 4. 配置 `wrangler.toml`

```toml
name = "temp-mail-console"
main = "src/index.js"
compatibility_date = "2024-11-01"

[[d1_databases]]
binding = "DB"
database_name = "temp-email-db"
database_id = "your-d1-database-id"

[vars]
ADMIN_TOKEN = "your-admin-token"
API_TOKEN = "your-api-token"

# 可选：调试正文保留天数，默认 2，设为 0 表示关闭
# DEBUG_BODY_RETENTION_DAYS = "2"

# 可选：提取后继续转发原始邮件
# FORWARD_TO = "your-real@email.com"

[triggers]
crons = ["0 * * * *"]
```

生产环境建议使用 `wrangler secret put` 设置敏感变量，不要直接写入仓库。

#### 5. 本地开发

```bash
npm run dev
```

访问 `http://localhost:8787/`。

#### 6. 部署

```bash
npm run deploy
```

## Email Routing 配置

- 在 Cloudflare 控制台进入 **Email -> Email Routing**。
- 配置 `Catch-all address` 或 `Custom addresses`。
- 动作选择 **Send to a Worker**，并绑定当前 Worker。

重要说明：

- 设为 **Send to a Worker** 后，Cloudflare 不会再自动把邮件转发到你的真实邮箱。
- 如果希望“提取 + 转发”同时进行，需要额外设置 `FORWARD_TO`。
- `FORWARD_TO` 对应地址必须是 Cloudflare Email Routing 中已验证过的 Destination Address。

## 环境变量

| 变量名 | 必填 | 说明 |
|------|------|------|
| `ADMIN_TOKEN` | 是 | 后台登录与 `/admin/*` 接口鉴权 |
| `API_TOKEN` | 是 | `/api/*` 接口鉴权 |
| `DEBUG_BODY_RETENTION_DAYS` | 否 | 调试正文保留天数，默认 `2`，设为 `0` 关闭 |
| `FORWARD_TO` | 否 | 提取后继续转发原始邮件 |

## 管理后台

- 访问 `https://<your-worker-domain>/`
- 输入 `ADMIN_TOKEN` 登录
- 登录后可查看：
  - 邮件列表
  - 命中规则
  - 白名单
  - 调试正文

后台的“查看调试正文”会展示：

- `text_content`
- `html_content`
- `normalized_text`
- `ranked_urls`
- 保存时间与过期时间

## API

### 鉴权

```http
Authorization: Bearer <API_TOKEN>
```

### 查询最新地址的最新命中结果

```http
GET /api/emails/latest?address=<email_address>
```

### 响应示例

```json
{
  "code": 200,
  "data": {
    "from_address": "otp@example.com",
    "to_address": "demo@yourdomain.com",
    "received_at": 1741881600000,
    "primary_result": {
      "rule_id": 1,
      "value": "123456",
      "remark": "验证码"
    },
    "results": [
      {
        "rule_id": 1,
        "value": "123456",
        "remark": "验证码"
      }
    ]
  }
}
```

### 字段说明

| 字段 | 说明 |
|------|------|
| `from_address` | 发件人邮箱 |
| `to_address` | 收件人邮箱，多个地址时逗号拼接 |
| `received_at` | 收件时间戳，毫秒 |
| `primary_result` | 当前最优命中结果，无命中时为 `null` |
| `results` | 归一化后的命中结果数组，当前默认只返回最优 1 条 |

### 常见错误

```json
{ "code": 404, "message": "message not found" }
```

## 规则说明

每条规则包含 3 个字段：

| 字段 | 说明 |
|------|------|
| `remark` | 备注名称，可作为返回结果标签 |
| `sender_filter` | 发件人过滤正则，多个规则可用逗号或换行分隔，留空表示所有发件人都可命中该规则 |
| `pattern` | 内容提取正则，对 `subject + normalized_text + ranked_urls` 做匹配 |

### 当前规则执行方式

- 单条规则会遍历全部命中，而不是只取第一个命中。
- 如果规则里有捕获组，返回值优先取第一个非空捕获组。
- 所有候选命中会统一排序后再输出最优结果。

### 当前排序倾向

- 6 位纯数字验证码优先级最高。
- 4 到 8 位纯数字次之。
- 6 到 8 位字母数字混合码次之。
- 备注中含有 `验证码`、`OTP`、`verification code` 等词会加分。
- 候选值附近如果出现 `code`、`verify`、`验证码` 等词会显著加分。
- 候选值附近如果更接近 `订单`、`金额`、`price`、`support` 等噪音词会减分。

### 示例 1：通用 6 位验证码

| 字段 | 值 |
|------|----|
| `remark` | `验证码` |
| `sender_filter` | 留空 |
| `pattern` | `\b\d{6}\b` |

### 示例 2：使用捕获组

| 字段 | 值 |
|------|----|
| `remark` | `验证码` |
| `sender_filter` | `.*@example\.com` |
| `pattern` | `验证码[:： ]*(\d{6})` |

在示例 2 中，系统最终返回的是 `123456`，不是整段 `验证码: 123456`。

## 白名单说明

- 白名单为空时，接收所有发件人和发件域名。
- 白名单不为空时，只处理匹配白名单规则的发件人。
- 白名单规则支持正则表达式。

换句话说：

- “能不能进入解析流程”取决于白名单。
- “进入后哪些规则会命中”取决于各规则自己的 `sender_filter` 和正文格式。

## 调试正文保留策略

系统不会永久保存所有邮件正文。当前支持“只保存最近 N 天调试正文”：

- 默认保留 `2` 天
- 通过 `DEBUG_BODY_RETENTION_DAYS` 调整
- 设置为 `0` 后，新邮件不再保存调试正文
- 旧邮件不会自动回填调试正文

当前调试正文表会保存：

- `text_content`
- `html_content`
- `normalized_text`
- `ranked_urls_json`
- `created_at`
- `expires_at`

Cron 会自动清理过期调试正文。

## 本地测试

### 发送测试邮件

```bash
curl -X POST "http://localhost:8787/cdn-cgi/handler/email?from=sender@example.com&to=demo@yourdomain.com" \
  --data-binary @./test/sample.eml
```

### 查询最新命中结果

```bash
curl "http://localhost:8787/api/emails/latest?address=demo@yourdomain.com" \
  -H "Authorization: Bearer dev-api-token"
```

## 项目结构

```text
├── src/
│   └── index.js
├── test/
│   └── sample.eml
├── images/
├── schema.sql
├── wrangler.toml
└── package.json
```

## License

MIT
