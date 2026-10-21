# 分享密码保护加固与前后端交接规范 (Share Password Hardening Handoff)

> **关联上游**：[xunxunProjects/Oyama-s-HRT-Tracker#117](https://github.com/xunxunProjects/Oyama-s-HRT-Tracker/issues/117) 及 PR [#118](https://github.com/xunxunProjects/Oyama-s-HRT-Tracker/pull/118) / [#119](https://github.com/xunxunProjects/Oyama-s-HRT-Tracker/pull/119)  
> **状态**：后端已完成全部逻辑与测试（`server/`），前端工具函数 `src/utils/passwordStrength.ts` 已就绪。本文档供前端 UI/交互团队落地前端改动。

---

## 1. 核心改进目标与架构背景

1. **弱口令拦截与信息熵门控 (Entropy Floor & Meter)**：
   - 杜绝纯数字（如 `12345678`）、常见英文单词（`password`、`admin`）、拼音/爱情缩写（`woaini`、`5201314`）、键盘走线（`qwerty`、`1qaz`）以及日期（如 `2000-01-01`）。
   - 服务端与前端统一要求密码估算信息熵必须 **≥ 40 bits**，低于 40 bits 时禁止创建并给出提示。
2. **单分享链接维度的指数退避锁定 (Per-Share Exponential Lockout)**：
   - 解决攻击者利用 Tor/代理池轮换 IP 绕过单个 IP 限速的问题。
   - 针对单个分享链接，连续输错密码达到 5 次后触发锁定 15 分钟；继续错误逐级倍增（30 分钟、封顶 60 分钟），返回 HTTP 429 与 `Retry-After`。
3. **访客免锁与免慢哈希凭证 (Viewer Pass)**：
   - 访客首次密码验证成功后，服务端下发带 HMAC-SHA256 签名的短期 `viewerPass` 凭证（有效期最长 24 小时或随分享到期）。
   - 开启实时同步（`live: true`）的页面每 10 秒轮询时，直接携带 `viewerPass`：
     - **CPU/性能收益**：跳过高开销的 `scrypt` 慢哈希计算，提升 99.9% 接口响应性能；
     - **高可用收益**：第三方外部爆破触发链接锁定时，**已正常解锁的读者不会被意外中断**，依然可流畅读取最新剂量。

---

## 2. 后端已落地的接口契约 (API Contracts)

### 2.1 创建分享 `POST /api/shares`
- **请求头**：`Authorization: Bearer <user_token>`
- **请求体**：
  ```json
  {
    "snapshot": { ... },
    "expiresAt": 1740000000000,
    "live": true,
    "password": "correct-horse-battery-99"
  }
  ```
- **服务端校验规则**：
  - 若传了 `password`，长度必须在 8~128 字符之间；
  - 调用 `estimatePasswordBits(password)` 计算熵值，若 `< 40`，返回 HTTP 400：
    ```json
    {
      "code": "SHARE_REJECTED",
      "message": "share password is too weak (10 bits estimated; minimum 40 bits required)"
    }
    ```

---

### 2.2 访问/解锁分享 `POST /api/shares/access`
- **无需登录鉴权**（公开接口，带 IP 滑动窗口限速）
- **请求体结构**：
  ```json
  {
    "token": "43_chars_base64url_token",
    "password": "optional_user_password",
    "viewerPass": "optional_signed_viewer_pass"
  }
  ```
- **响应状态码与响应体**：

#### ① 成功 `200 OK`
```json
{
  "passwordRequired": true,
  "live": true,
  "createdAt": 1729000000000,
  "updatedAt": 1729000000000,
  "expiresAt": 1730000000000,
  "snapshot": { ... },
  "mode": "transfem",
  "viewerPass": "eyJ2IjoxLCJ0aCI6...base64url"
}
```
> **注意**：当密码受保护且首次解锁成功时，返回的 JSON 会附带 `viewerPass`。前端应将此凭证保存在内存或 sessionStorage 中。

#### ② 需要密码 `401 Unauthorized`
```json
{
  "code": "PASSWORD_REQUIRED",
  "passwordRequired": true,
  "message": "password_required"
}
```

#### ③ 密码错误 `401 Unauthorized`
```json
{
  "code": "INVALID_PASSWORD",
  "message": "invalid_password"
}
```
> 后端会自动原子递增 `failed_attempts`。达到 5 次将触发锁定。

#### ④ 链接被防爆破锁定 `429 Too Many Requests`
- **响应头**：`Retry-After: 900`（单位：秒）
- **响应体**：
  ```json
  {
    "code": "SHARE_LOCKED",
    "message": "too many wrong passwords; share is temporarily locked",
    "retryAfterSeconds": 900
  }
  ```

#### ⑤ 链接过期 `410 Gone`
```json
{
  "code": "SHARE_EXPIRED",
  "message": "expired"
}
```

#### ⑥ 链接不存在 `404 Not Found`
```json
{
  "code": "SHARE_NOT_FOUND",
  "message": "not found"
}
```

---

## 3. 前端工程落地指南 (Frontend Tasks)

### 3.1 核心工具函数（已完成）
工具文件位于 `src/utils/passwordStrength.ts`，可直接引入：
```typescript
import {
  estimatePasswordBits,
  passwordStrength,
  isPasswordAcceptable,
  WEAK_BITS, // 40
  STRONG_BITS // 60
} from '../utils/passwordStrength';

// 1. 获取估算比特数 (number):
const bits = estimatePasswordBits(password);

// 2. 获取档位 ('weak' | 'fair' | 'strong'):
const level = passwordStrength(password);

// 3. 快速合规判断:
const { acceptable, reason } = isPasswordAcceptable(password);
// acceptable: false, reason: 'too_short' | 'too_long' | 'too_weak'
```

---

### 3.2 服务层改造 `src/services/sharing.ts`
1. **接口类型增加 `viewerPass`**：
   ```typescript
   export interface ShareDetails {
       passwordRequired: boolean;
       live: boolean;
       createdAt: number;
       updatedAt: number;
       expiresAt: number | null;
       snapshot: SharedDosageSnapshot;
       viewerPass?: string; // 新增
   }
   ```
2. **方法签名与请求体适配**：
   - `open(token: string, viewerPass?: string)`:
     ```typescript
     body: JSON.stringify({ token, viewerPass })
     ```
   - `unlock(token: string, password?: string, viewerPass?: string)`:
     ```typescript
     body: JSON.stringify({ token, password, viewerPass })
     ```
   - `ShareApiError`: 支持捕获 429 时的 `Retry-After` 和 `retryAfterSeconds`。

---

### 3.3 创建分享页 `src/pages/ShareSettings.tsx`
在设置密码时（`passwordEnabled === true`）：
1. **增加动态密码强度指示条 (Entropy Meter)**：
   - 位于密码输入框下方；
   - 范围 0 ~ 80 bits，平滑过渡（CSS `transition: width 0.3s cubic-bezier(0.2, 0.9, 0.3, 1)`）；
   - **M3E 色彩令牌**：
     - `< 40 bits`：危险色 `--color-m3-error` (`var(--err)`)，提示“密码过弱，请避免常见组合或加长”；
     - `40 ~ 60 bits`：过渡色 `--color-m3-surface-variant` (`var(--var)`)，提示“强度尚可”；
     - `≥ 60 bits`：主强调色 `--color-m3-primary` (`var(--pri)`)，提示“强口令保护”。
2. **提交按钮拦截门控**：
   - 当 `passwordEnabled` 为 true 时，若 `estimatePasswordBits(password) < 40`，禁用“创建分享”按钮（`disabled={passwordEnabled && estimatePasswordBits(password) < 40}`）。

---

### 3.4 访客查看页 `src/pages/PublicShare.tsx`
1. **持有 `viewerPass`**：
   - 页面加载首次 `unlock` 或 `open` 成功后：
     `viewerPassRef.current = details.viewerPass || '';`
2. **实时同步循环 (`refresh`)**：
   - 优先使用 `viewerPassRef.current` 发起请求：
     ```typescript
     const result = viewerPassRef.current
         ? await sharingService.unlock(token, undefined, viewerPassRef.current)
         : (unlockedPasswordRef.current
             ? await sharingService.unlock(token, unlockedPasswordRef.current)
             : await sharingService.open(token));
     ```
3. **处理 429 `SHARE_LOCKED` 锁定态**：
   - 当收到 429 时，从错误中获取 `retryAfterSeconds`；
   - 页面保持在输入表单态，并在表单下方显示倒计时提示：
     > “错误次数过多，该分享已临时锁定，请在 X 分钟后再试”
   - 避免直接跳转到 404 或清空用户已有状态。

---

### 3.5 多语言文案 (i18n)
在 `src/i18n/langs/*.ts` 或 `src/i18n/share.ts` 中补充以下词条对应翻译（中、英、日、韩、粤、繁中、土耳其）：
- `share.passwordTooWeak`: 密码太容易被猜到，请避免生日、常见词或纯数字（需 40 位以上强度）
- `share.passwordFair`: 密码强度适中，可添加更多字符进一步提高安全性
- `share.passwordStrong`: 密码强度良好
- `share.shareLocked`: 输错密码次数过多，该链接已临时锁定，请在 {time} 后重试
