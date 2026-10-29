# Manual คู่มือชีวิตเชียงใหม่

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [ไทย](README.th.md) · [เว็บไซต์ตัวอย่าง](https://cm.caishen.today)

## ภาพรวม

Manual เปลี่ยนข้อมูลสถานที่ใน Notion ให้เป็น PWA บนมือถือที่ปลอดภัย รวมการเข้าสู่ระบบด้วย PIN การค้นหา ตัวกรองหมวดหมู่และระยะทาง ลูกโลกแบบโต้ตอบ รายการ Google Maps การแชร์จากชุมชน และการแก้ไขร่วมกันของผู้ดูแล เว็บตัวอย่างต้องใช้บัญชีและไม่เปิดเผยรหัสผ่าน

## ความสามารถ

- PWA ภาษาจีน อังกฤษ ญี่ปุ่น และไทย
- PIN 4 หลัก scrypt เซสชันที่ลงนาม การจำกัดความถี่ และบันทึกตรวจสอบ
- รหัสเชิญที่จำกัดจำนวนครั้งและยกเลิกได้
- ซิงก์ทางเดียวจาก Notion แบบตามเวลา
- ที่อยู่ เวลาเปิด โทรศัพท์ เว็บไซต์ การจอง และรูปภาพจาก Google Maps
- มุมมองลูกโลกและรายการ ค้นหาใกล้เคียง 200 เมตรถึง 10 กิโลเมตร
- 5 ดาวต่อสถานที่ใหม่ และเป็นผู้ดูแลร่วมอัตโนมัติที่ 30 ดาว
- ผู้ดูแลและผู้ดูแลร่วมแก้ไขข้อมูลแสดงผลได้ทันที

## สถาปัตยกรรม

```text
Notion -> ซิงก์ทางเดียว -> data/ + แคช Google Maps
                             |
                             v
บริการ Node.js <- runtime/ ผู้ใช้ การแชร์ รูปภาพ การแก้ไข และการตรวจสอบ
       |
       v
PWA บนมือถือ -> Cloudflare Tunnel -> HTTPS
```

Notion เป็นแหล่งรวบรวม สถานะชุมชนเก็บใน `runtime/` จึงไม่หายเมื่อซิงก์ Notion และเว็บไซต์ไม่เขียนกลับไปยัง Notion

## การติดตั้ง

ต้องใช้ Node.js 22 ขึ้นไป

```bash
cp .env.example .env
npm install
npm start
npm run hash-pin -- 1234
```

ตัวแปหลักคือ `SESSION_SECRET`, `PIN_USERS_JSON`, `NOTION_TOKEN`, `SYNC_INTERVAL_MINUTES`, `GOOGLE_MAPS_API_KEY` และ `RUNTIME_DIR` ห้าม commit PIN, API key, token, SSH private key หรือ `.env` ของระบบจริง

## ซิงก์ ทดสอบ และ Docker

```bash
NOTION_TOKEN=your_token npm run sync:notion
npm test
docker compose up -d --build
curl http://127.0.0.1:3010/healthz
```

ระบบจริงต้องเก็บ `runtime/` แบบถาวรและใช้ HTTPS เว็บตัวอย่างคือ <https://cm.caishen.today>

## ความปลอดภัย

PIN เก็บเฉพาะ scrypt hash ที่มี salt เซสชันใช้ HttpOnly signed cookie การเข้าระบบผิดพลาดจะถูกจำกัดแบบทวีคูณ และการกระทำของผู้ดูแลจะถูกบันทึก
