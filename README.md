# Gateway Panel — Cloudflare Control Plane

این شاخه، مرحله‌ی اول مهاجرت Gateway به Cloudflare Workers است.

در این مرحله فقط **Control Plane** پیاده‌سازی شده است:

- ورود امن مدیر
- داشبورد مدیریتی
- مدیریت لینک‌ها و کانفیگ‌ها
- گروه‌های Subscription
- صفحات عمومی Subscription
- آمار و لاگ‌ها
- تنظیمات
- ربات Telegram با Webhook
- D1 برای داده‌ی دائمی
- KV برای Session و وضعیت موقت Wizard

> VLESS WebSocket Relay، XHTTP و Durable Object Tunnel عمداً در این مرحله پیاده‌سازی نشده‌اند. این مسیرها پاسخ `501 Not Implemented` برمی‌گردانند و در مرحله‌ی دوم بررسی می‌شوند.

## تفاوت‌های مهم با نسخه‌ی Python

- Python، FastAPI، Uvicorn، `asyncio` و فایل‌های محلی در نسخه‌ی Worker استفاده نمی‌شوند؛ فایل‌های legacy Python در checkout فقط برای مرجع فاز دوم باقی مانده‌اند و در Deploy Worker وارد نمی‌شوند.
- `gateway_state.json` و مسیر `/data` منبع ذخیره‌سازی نیستند.
- رمز پیش‌فرض `admin` حذف شده است.
- اولین رمز مدیر باید از طریق Secret با نام `ADMIN_PASSWORD` تنظیم شود.
- پورت اتصال برای Cloudflare روی `443` ثابت شده است.
- Open HTTP Proxy در مرحله‌ی Control Plane غیرفعال است تا قبل از پیاده‌سازی دوباره، کنترل SSRF و دسترسی آن مشخص شود.
- QR Code توسط خود Worker به‌صورت SVG تولید می‌شود؛ هیچ QR API خارجی استفاده نمی‌شود.
- Chart.js، فونت Google و آیکن‌های CDN حذف شده‌اند. آیکن‌ها به‌صورت فایل محلی در `public/assets` قرار دارند و نمودارها با Renderer سبک داخلی رسم می‌شوند.

## ساختار پروژه

```text
src/
├── index.ts          # Worker router و APIها
├── pages.ts          # Login، Dashboard و Public Subscription HTML
├── auth.ts           # PBKDF2، Session، Cookie و CSRF
├── database.ts       # D1 helpers و مدل‌های داده
├── links.ts          # Link management و VLESS link generation
├── subscriptions.ts  # Subscription groups و public feeds
├── stats.ts          # Statistics، activity و connections
├── telegram.ts       # Telegram webhook و wizard
└── utils.ts          # Crypto، parsing، cookies و response helpers

public/assets/
├── tabler-icons.min.css
└── fonts/tabler-icons.woff2

schema.sql
wrangler.toml
package.json
package-lock.json
tsconfig.json
.env.example
```

## نیازمندی‌ها

- Node.js و npm
- حساب Cloudflare با Workers، D1 و KV فعال
- دامنه‌ی Cloudflare برای استفاده‌ی واقعی از Webhook تلگرام
- هیچ VPS، Railway، Render، R2 یا سرویس پولی لازم نیست

## نصب

```bash
npm install
npx wrangler login
```

## ساخت D1

```bash
npx wrangler d1 create panel-db
```

خروجی Wrangler شامل `database_id` است. مقدار آن را در `wrangler.toml` جایگزین کنید:

```toml
[[d1_databases]]
binding = "DB"
database_name = "panel-db"
database_id = "YOUR_DATABASE_ID"
```

سپس Schema را روی دیتابیس Remote اجرا کنید:

```bash
npx wrangler d1 execute panel-db --remote --file=schema.sql
```

برای دیتابیس Local در زمان توسعه:

```bash
npx wrangler d1 execute panel-db --local --file=schema.sql
```

## ساخت KV

```bash
npx wrangler kv namespace create TEMP
```

مقدار namespace ID را در `wrangler.toml` قرار دهید:

```toml
[[kv_namespaces]]
binding = "TEMP"
id = "YOUR_KV_NAMESPACE_ID"
```

KV در این مرحله برای موارد زیر استفاده می‌شود:

- Sessionهای کوتاه‌مدت مدیر
- وضعیت موقت Wizard تلگرام

در Control Plane فعلی Durable Object لازم نیست؛ بنابراین binding مربوط به Tunnel عمداً در `wrangler.toml` اضافه نشده است. در مرحله‌ی دوم، فقط برای Sessionهای زنده‌ی VLESS/XHTTP و Limiter در صورت تأیید اضافه خواهد شد.

داده‌ی اصلی لینک‌ها، گروه‌ها، لاگ‌ها و آمار در D1 باقی می‌ماند.

## Secrets

رمز پیش‌فرض وجود ندارد. قبل از اولین ورود، Secretها را تنظیم کنید:

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SECRET_KEY
```

`ADMIN_PASSWORD` فقط برای ساخت اولین حساب مدیر استفاده می‌شود. پس از اولین ورود، رمز جدید را از داخل داشبورد تغییر دهید.

برای فعال‌کردن Telegram:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_ADMIN_IDS
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

`TELEGRAM_ADMIN_IDS` باید فهرستی از IDهای عددی تلگرام باشد:

```text
123456789,987654321
```

## Deploy

```bash
npx wrangler deploy
```

یا:

```bash
npm run deploy
```

بعد از Deploy:

```text
https://YOUR_WORKER_DOMAIN/login
```

## تنظیم Telegram Webhook

پس از Deploy، Webhook را با URL عمومی Worker تنظیم کنید. مقدار Secret Token باید همان مقدار `TELEGRAM_WEBHOOK_SECRET` باشد:

```bash
curl -X POST "https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook" \
  -d "url=https://YOUR_WORKER_DOMAIN/telegram/webhook" \
  -d "secret_token=YOUR_WEBHOOK_SECRET" \
  -d 'allowed_updates=["message","callback_query"]'
```

ربات Control Plane پشتیبانی می‌کند از:

- `/start`
- `/menu`
- `/cancel`
- لیست کانفیگ‌ها
- مشاهده‌ی جزئیات
- فعال/غیرفعال‌سازی
- حذف با تأیید
- ساخت کانفیگ با Wizard
- ساخت و مدیریت پایه‌ی گروه‌های Subscription

## APIهای Control Plane

APIهای اصلی نسخه‌ی قبلی حفظ شده‌اند:

```text
POST   /api/login
POST   /api/logout
GET    /api/me
POST   /api/change-password

GET    /api/links
POST   /api/links
PATCH  /api/links/:uuid
DELETE /api/links/:uuid

GET    /api/subs
POST   /api/subs
PATCH  /api/subs/:sub_id
DELETE /api/subs/:sub_id
POST   /api/subs/:sub_id/links

GET    /api/activity
GET    /api/connections
GET    /stats
GET    /api/settings
PATCH  /api/settings

GET    /sub/:uuid
GET    /sub-group/:uuid_key
GET    /p/:uuid_key
GET    /api/public/sub/:uuid_key
GET    /api/qr?data=...

POST   /telegram/webhook
```

تمام APIهای مدیریتی به Session Cookie و برای درخواست‌های تغییر‌دهنده به CSRF Double Submit Token نیاز دارند. Dashboard این Header را به‌صورت خودکار ارسال می‌کند.

## Database tables

`schema.sql` این جداول را ایجاد می‌کند:

- `admins`
- `links`
- `subscriptions`
- `traffic`
- `connections`
- `logs`
- `settings`

رابطه‌ی گروه و لینک از طریق `links.sub_id` نگهداری می‌شود و مانند نسخه‌ی JSON در دو محل تکرار نمی‌شود.

## مهاجرت State قدیمی

در این Checkout فایل واقعی `gateway_state.json` وجود ندارد؛ نسخه‌ی قدیمی فقط در زمان اجرا آن را در `/data` ایجاد می‌کرد. بنابراین Schema جدید از ابتدا با D1 شروع می‌شود.

برای Import کردن یک فایل State قدیمی از اسکریپت Node استفاده کنید؛ این اسکریپت به Python runtime نیاز ندارد:

```bash
node scripts/import-state.mjs /path/to/gateway_state.json state-migration.sql
npx wrangler d1 execute panel-db --remote --file=state-migration.sql
```

اسکریپت موارد زیر را منتقل می‌کند:

- `links` به جدول `links`
- `subs` به جدول `subscriptions`
- مقدارهای `used_bytes`
- ارتباط گروه و لینک
- هش قدیمی مدیر و رمز گروه با علامت `legacy-sha256$`

برای ارتقای تدریجی هش‌های قدیمی، Secret قبلی که در `gateway_secret.key` یا `SECRET_KEY` نسخه‌ی Python بوده است را موقتاً تنظیم کنید:

```bash
npx wrangler secret put LEGACY_SECRET_KEY
```

پس از اولین ورود موفق مدیر، هش مدیر به PBKDF2 تبدیل می‌شود. هش گروه‌ها تا زمان اولین استفاده با Secret قدیمی قابل بررسی هستند. بعد از اطمینان از مهاجرت، Secret قدیمی و فایل JSON را حذف کنید.

هش‌های قدیمی SHA-256 بدون دانستن Secret قدیمی قابل بررسی نیستند؛ فایل State و Secret قدیمی را هم‌زمان حذف نکنید.

## مسیرهای مرحله‌ی دوم

مسیرهای زیر عمداً هنوز Relay نیستند:

```text
/ws/:uuid
/xhttp-siz10/...
/proxy/...
```

پاسخ آن‌ها `501 Not Implemented` است. مرحله‌ی دوم باید جداگانه طراحی و تأیید شود و شامل موارد زیر خواهد بود:

- VLESS WebSocket
- XHTTP
- Durable Object Tunnel Session
- outbound TCP socket
- traffic accounting روی مسیر واقعی اتصال
- Durable Object speed limiter

این مرحله هیچ کد Relay یا XHTTP تولید نمی‌کند.

## محدودیت‌های Cloudflare که روی این مهاجرت اثر دارند

- Worker ورودی خام TCP را به‌صورت Listener دریافت نمی‌کند؛ بنابراین Worker نمی‌تواند جایگزین یک VPS یا Listener مستقیم VLESS شود. مسیر Relay باید در فاز جداگانه با معماری سازگار Cloudflare طراحی شود.
- D1 دیتابیس SQLite سازگار با Worker است و برای داده‌ی مدیریتی مناسب است، اما محدودیت Query، حجم و سهمیه دارد؛ هر Invocation سقف Query دارد و این پیاده‌سازی عمداً از الگوی N+1 در فهرست گروه‌ها پرهیز می‌کند. در هر Invocation نباید آن را با ثبت per-packet ترافیک اشباع کرد. سقف‌های Free فعلی در مستندات Cloudflare شامل حدود ۵ میلیون row read/day، ۱۰۰ هزار row write/day و ۵۰۰ MB برای هر Database است؛ قبل از Production سقف حساب را بررسی کنید.
- KV برای Session و Wizard موقت مناسب است، اما eventual consistency دارد و نباید منبع authoritative برای Quota، Rate Limit یا accounting دقیق باشد. سقف Free فعلی حدود ۱۰۰ هزار read/day، ۱۰۰۰ write/delete/day و ۱ GB است.
- Workerهای Free نیز سقف روزانه‌ی درخواست و محدودیت CPU/حافظه/Subrequest دارند؛ اعداد Plan ممکن است تغییر کنند و باید در زمان Deploy بررسی شوند. این پروژه Relay را به‌عنوان VPS بی‌نهایت یا مسیر عبور ترافیک پیاده نمی‌کند.
- Cloudflare فقط پورت‌های HTTP/HTTPS مشخص را Proxy می‌کند؛ به همین دلیل پورت تولیدشده‌ی لینک‌ها 443 است و پورت دلخواه نسخه‌ی Python حفظ نشده است.
- Durable Object و WebSocket/Tunnel طولانی‌مدت برای فاز دوم نیازمند طراحی و بررسی هزینه/ظرفیت هستند؛ binding آن‌ها در فاز Control Plane عمداً وجود ندارد.
- فایل محلی، `/data` و R2 در این فاز استفاده نمی‌شوند. Assetهای Dashboard داخل Worker/Static Assets بسته‌بندی شده‌اند.
- Telegram فقط از HTTPS Webhook استفاده می‌کند؛ تا وقتی `TELEGRAM_WEBHOOK_SECRET` تنظیم نباشد، endpoint وب‌هوک فعال نمی‌شود.
