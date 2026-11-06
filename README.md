# Discord Multi-Bot Music Player

مشروع موسيقى لأكثر من بوت ديسكورد باستخدام discord.js v14 و @discordjs/voice و yt-dlp و FFmpeg.

## الأوامر

- `!start VOICE_CHANNEL_ID` — يدخل أول بوت فاضي إلى الروم الصوتي المحدد.
- `!song URL` — يشغّل الرابط أو يضيفه للقائمة. لازم تكون في نفس الروم الموجود فيه البوت.
- `!stop` — يوقف الموسيقى ويطلع البوت الموجود في رومك.

بعد بدء التشغيل تظهر لوحة فيها: السابقة، تشغيل/إيقاف مؤقت، التالية، و Playlist.

## 1) التثبيت على Windows بدون pip

افتح CMD أو Windows Terminal ونفّذ:

```bat
winget install -e --id OpenJS.NodeJS.LTS
winget install --source winget -e --id yt-dlp.yt-dlp
winget install -e --id Gyan.FFmpeg
winget install -e --id DenoLand.Deno
```

بعد التثبيت، اقفل CMD وافتحه من جديد، ثم تأكد:

```bat
node -v
npm -v
yt-dlp --version
ffmpeg -version
deno --version
```

## 2) تجهيز التوكنات

1. انسخ `tokens.txt.example`.
2. سمّ النسخة `tokens.txt`.
3. حط كل توكن بوت في سطر مستقل، بدون علامات اقتباس.
4. لا ترفع `tokens.txt` إلى GitHub؛ الملف مستثنى في `.gitignore`.

تقدر بدلاً من الملف تعيّن متغير بيئة اسمه `TOKENS`، وتفصل التوكنات بأسطر أو بفواصل.

## 3) تشغيل البوت

من داخل مجلد المشروع:

```bat
npm install
node index.js
```

أو شغّل `start.bat`؛ يسوي `npm install` وبعدها يشغّل `node index.js`.

## 4) إعداد Discord Developer Portal

لكل تطبيق بوت:

1. فعّل **Message Content Intent** من Bot → Privileged Gateway Intents.
2. أضف البوت للسيرفر بصلاحيات: View Channels, Send Messages, Embed Links, Connect, Speak.
3. إذا عندك أكثر من بوت، أضف كلهم للسيرفر نفسه.

استخدم التوكن من صفحة Bot فقط، ولا تشاركه مع أحد.

## 5) Render باستخدام Docker

هذا البرنامج بوت دائم وما يحتاج منفذ HTTP؛ أنشئ **Background Worker** واختر **Docker** واربط مستودع GitHub.

- Dockerfile Path: `./Dockerfile`
- Build Command: غير مطلوب في وضع Docker؛ Render يبني الصورة من Dockerfile.
- Start Command: اتركه فارغاً لاستخدام `CMD` في Dockerfile، أو اكتب `node index.js`.
- Environment Variables:
  - `TOKENS` = التوكنات، كل توكن في سطر منفصل.
  - `MAX_QUEUE` = اختياري، افتراضياً `50`.
  - `YTDLP_PATH` و `FFMPEG_PATH` = اختياري، اتركهما فارغين على Render.

لو اخترت بيئة Node بدلاً من Docker، استخدم Build Command: `npm install` و Start Command: `node index.js`، لكن لازم تثبّت yt-dlp وFFmpeg وDeno بنفسك في بيئة التشغيل. Docker أسهل لهذا المشروع.

مهم: Render لا يوفر خطة Free للـ Background Workers؛ يلزم اختيار خطة مدفوعة لهذا النوع من الخدمات. لا تنشئ Web Service عادي لهذا البوت إلا إذا أضفت له خادم HTTP وفهمت قيود الخطة المجانية.

## ملاحظات تشغيلية

- أول بوت جاهز وفاضي وموجود في السيرفر هو اللي يدخل الروم. إذا كان بوت آخر مشغلاً في نفس الروم، لن ينشئ جلسة ثانية في الروم نفسه.
- يتم توجيه `!song` و `!stop` حسب الروم الصوتي الذي يوجد فيه المستخدم.
- كل بوت له اتصال ومشغّل وقائمة خاصة لكل سيرفر. `group` منفصل لكل بوت/سيرفر عند `joinVoiceChannel`.
- يستخدم yt-dlp لاستخراج بيانات الرابط ورابط البث المباشر، ثم يمرر الرابط إلى FFmpeg لتحويل الصوت إلى PCM ‏48kHz / stereo عبر stdout. لا يستخدم `yt-dlp -o -`.
- الروابط المدعومة تعتمد على مواقع yt-dlp وإمكانية الوصول للمصدر. الروابط الخاصة أو المحمية أو المحجوبة جغرافياً قد لا تعمل، وقد تتغير آلية بعض المواقع.
- DAVE مفعّل عبر @discordjs/voice 0.19.2 وتثبيت @snazzah/davey. هذا يجهّز توافق مكتبة الصوت مع DAVE، لكنه لا يضمن عدم حدوث أي عطل خارجي في Discord أو الشبكة.
- إذا تغيّرت نسخ الحزم أو yt-dlp لاحقاً، حدّثها واختبر التشغيل من جديد.
