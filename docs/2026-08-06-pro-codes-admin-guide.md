# Pro 兑换码 — 管理员调用手册

> 适用 migration: `20260103_membership.sql` + `20260104_redeem_rpc.sql` + `20260105_generate_pro_codes.sql`

---

## 生成兑换码

### 1. 单种时长批量

`generate_pro_codes(count, duration_days, tag, validity)`

| 参数 | 默认 | 说明 |
|------|------|------|
| `count` | 必填 | 1–1000 |
| `duration_days` | 必填 | 兑换后给客户的 Pro 时长(>0) |
| `tag` | `'M'` | 1–8 位大写字母数字,标识批次/渠道 |
| `validity` | `'1 year'` | 码本身的有效期(**与 Pro 时长无关**) |

```sql
-- 10 个月卡
SELECT * FROM public.generate_pro_codes(10, 30, 'M');

-- 5 个季卡, 2 年内有效
SELECT * FROM public.generate_pro_codes(5, 90, 'Q', '2 years');

-- 20 个微信渠道专用月卡
SELECT * FROM public.generate_pro_codes(20, 30, 'WECHAT');
```

返回 `code / duration_days / expires_at` 三个字段。

### 2. 混合批量(一次出月+季+年)

`generate_pro_codes_multi(specs jsonb)`

```json
[
  {"count": 5, "duration_days": 30,  "tag": "M"},
  {"count": 3, "duration_days": 90,  "tag": "Q"},
  {"count": 2, "duration_days": 365, "tag": "Y"}
]
```

`validity` 字段可选(每条 spec 自己覆盖,默认 1 year)。

```sql
-- 月+季+年 一把出
SELECT * FROM public.generate_pro_codes_multi('[
  {"count": 5, "duration_days": 30,  "tag": "M"},
  {"count": 3, "duration_days": 90,  "tag": "Q"},
  {"count": 2, "duration_days": 365, "tag": "Y"}
]'::jsonb);

-- 多渠道混合 + 不同有效期
SELECT * FROM public.generate_pro_codes_multi('[
  {"count": 20, "duration_days": 30,  "tag": "WECHAT"},
  {"count": 10, "duration_days": 30,  "tag": "PROMO",   "validity": "2 weeks"},
  {"count":  5, "duration_days": 365, "tag": "INFLU"}
]'::jsonb);
```

**返回顺序**: `duration_days DESC, code ASC` — 年卡在前,月卡在后。

### 码格式

```
NATIVEOS-{TAG}-{序号}-{随机6位}
例: NATIVEOS-M-01-A3F2BX
        └── tag (1-8位大写)
              └── 序号 (01 起, 按生成顺序)
                    └── 6位 hex 大写
```

---

## 排错

### 客户端兑换报"兑换码无效"

```sql
-- 查码的真实状态
SELECT code, used_by, expires_at, expires_at > now() AS is_valid
FROM public.pro_codes
WHERE code = '<用户输入的码>';
```

- 0 行 → 码不存在
- `is_valid = false` → 码过期
- `used_by` 不为 NULL → 码已被用

### 报 `permission denied`

你是 SQL Editor 跑还是 service_role key 调?这两者能跑,app 端 PostgREST 不能跑(预期行为)。

### 想给某用户强行开 Pro(不走码)

```sql
UPDATE public.profiles
SET is_pro = true,
    pro_expires_at = now() + interval '30 days',
    updated_at = now()
WHERE id = '<user-uid>';
```
