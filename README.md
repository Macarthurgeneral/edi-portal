# EDI Exchange Portal
### ANSI X12 Trading Partner Portal — OrderDog POS Integration

---

## What This Does

A self-hosted web portal you deploy on a VPS. Your POS provider (OrderDog) logs in and exchanges:

| Transaction | Type | Direction |
|---|---|---|
| Purchase Order | 850 | OrderDog → You |
| Functional Acknowledgement | 997 | You → OrderDog |
| PO Acknowledgement | 855 | You → OrderDog |
| Invoice | 810 | You → OrderDog |
| Catalog Flat File | — | You → OrderDog (daily) |

**Bonus:** AI-powered Invoice Converter — upload a PDF or CSV invoice and it auto-generates a compliant EDI 810 file into the mailbox.

---

## VPS Deployment (Ubuntu/Debian)

### 1. Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Upload files to your VPS

```bash
# From your local machine
scp -r ./edi-portal user@your-vps-ip:/home/user/
```

Or clone/upload via SFTP.

### 3. Install dependencies

```bash
cd /home/user/edi-portal
npm install
```

### 4. Configure environment

```bash
cp .env.example .env
nano .env
```

Fill in:
- `SESSION_SECRET` — any long random string (e.g. run `openssl rand -hex 32`)
- `ANTHROPIC_API_KEY` — your key from https://console.anthropic.com (for invoice converter)
- `PORT` — 3000 is fine; put Nginx in front for port 80/443

### 5. Run with PM2 (recommended — keeps it alive on reboot)

```bash
sudo npm install -g pm2
pm2 start server.js --name edi-portal
pm2 save
pm2 startup   # follow the printed command to enable on boot
```

### 6. (Optional) Nginx reverse proxy for port 80/443

```bash
sudo apt install nginx
sudo nano /etc/nginx/sites-available/edi-portal
```

Paste:
```nginx
server {
    listen 80;
    server_name your-domain-or-ip;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_cache_bypass $http_upgrade;
        client_max_body_size 25M;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/edi-portal /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

For HTTPS, use Certbot:
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

## Default Credentials

| Username | Password | Role |
|---|---|---|
| `admin` | `admin123` | Store admin |
| `orderdog` | `pospass1` | OrderDog POS |

**⚠️ CHANGE THESE IMMEDIATELY** after first login via the Users panel.

---

## Changing Passwords

Log in as `admin` → Users → Remove the old account → Add User with new credentials.

Or edit `data/users.json` directly (passwords are bcrypt hashed automatically on the next user creation).

---

## File Structure

```
edi-portal/
├── server.js           ← Main server
├── package.json
├── .env                ← Your config (create from .env.example)
├── public/
│   └── index.html      ← Full frontend SPA
├── edi-files/
│   ├── 850/            ← Purchase Orders mailbox
│   ├── 997/            ← Functional Ack. mailbox
│   ├── 855/            ← PO Ack. mailbox
│   ├── 810/            ← Invoices mailbox
│   └── catalog/        ← Catalog flat files (daily pickup)
├── uploads/            ← Temp invoice uploads for conversion
└── data/
    ├── users.json      ← User accounts
    └── audit.json      ← Activity log
```

---

## Invoice → EDI 810 Converter

Requires an Anthropic API key in `.env`.

Supported input formats:
- PDF invoices
- CSV / Excel exports
- PNG/JPG scans of paper invoices

The AI reads the invoice, extracts line items, pricing, dates, and generates a standards-compliant ANSI X12 810 EDI file saved directly to the `810/` mailbox for OrderDog to download.

---

## Security Notes

- All passwords are bcrypt hashed (no plaintext storage)
- Session-based auth with configurable expiry (8 hours default)
- Full audit log of all uploads, downloads, deletions, logins
- Run behind Nginx + HTTPS for production
- Restrict VPS firewall to only allow your IP + OrderDog's IP on port 3000 (or 443)

---

## Firewall (Optional, Recommended)

```bash
sudo ufw allow ssh
sudo ufw allow 80
sudo ufw allow 443
# Optional: restrict port 3000 to specific IPs only
sudo ufw allow from YOUR_IP to any port 3000
sudo ufw allow from ORDERDOG_IP to any port 3000
sudo ufw enable
```
