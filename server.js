const express = require('express');
const multer = require('multer');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Directories ────────────────────────────────────────────────────────────
const DIRS = {
  uploads: path.join(__dirname, 'uploads'),
  edi: path.join(__dirname, 'edi-files'),
  data: path.join(__dirname, 'data'),
  850: path.join(__dirname, 'edi-files/850'),
  997: path.join(__dirname, 'edi-files/997'),
  855: path.join(__dirname, 'edi-files/855'),
  810: path.join(__dirname, 'edi-files/810'),
  catalog: path.join(__dirname, 'edi-files/catalog'),
};
Object.values(DIRS).forEach(d => fs.mkdirSync(d, { recursive: true }));

// ─── Users DB (flat file) ────────────────────────────────────────────────────
const USERS_FILE = path.join(DIRS.data, 'users.json');
if (!fs.existsSync(USERS_FILE) || process.env.RESET_USERS === 'true') {
  const admin_hash = bcrypt.hashSync('EDIInvoicing!1', 10);
  const pos_hash   = bcrypt.hashSync('pospass1', 10);
  fs.writeFileSync(USERS_FILE, JSON.stringify([
    { id: 1, username: 'admin',    password: admin_hash, role: 'admin',    name: 'Store Admin' },
    { id: 2, username: 'orderdog', password: pos_hash,   role: 'pos',      name: 'OrderDog POS' },
  ], null, 2));
}

// ─── Audit log ───────────────────────────────────────────────────────────────
const LOG_FILE = path.join(DIRS.data, 'audit.json');
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '[]');

function log(user, action, detail) {
  const logs = JSON.parse(fs.readFileSync(LOG_FILE));
  logs.unshift({ ts: new Date().toISOString(), user, action, detail });
  if (logs.length > 500) logs.splice(500);
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
}

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'edi-portal-secret-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Multer ──────────────────────────────────────────────────────────────────
const ediStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const type = req.params.type || '810';
    const dir = DIRS[type] || DIRS['810'];
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ts = Date.now();
    cb(null, `${ts}_${file.originalname}`);
  }
});
const invoiceStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DIRS.uploads),
  filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`)
});
const ediUpload     = multer({ storage: ediStorage });
const invoiceUpload = multer({ storage: invoiceStorage, limits: { fileSize: 20 * 1024 * 1024 } });

// ─── Auth helpers ─────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'Not authenticated' });
}
function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') return next();
  res.status(403).json({ error: 'Admin only' });
}
function getUsers() { return JSON.parse(fs.readFileSync(USERS_FILE)); }
function saveUsers(u) { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2)); }

// ─── Auth routes ─────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const users = getUsers();
  const user  = users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    log(username, 'LOGIN_FAIL', 'Bad credentials');
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  req.session.user = { id: user.id, username: user.username, role: user.role, name: user.name };
  log(user.username, 'LOGIN', 'Success');
  res.json({ success: true, role: user.role, name: user.name });
});

app.post('/api/logout', (req, res) => {
  if (req.session.user) log(req.session.user.username, 'LOGOUT', '');
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json(req.session.user);
});

// ─── EDI file routes ──────────────────────────────────────────────────────────
// List files for a transaction type
app.get('/api/edi/:type', requireAuth, (req, res) => {
  const { type } = req.params;
  const dir = DIRS[type];
  if (!dir) return res.status(400).json({ error: 'Unknown EDI type' });
  const files = fs.readdirSync(dir)
    .filter(f => !f.startsWith('.'))
    .map(f => {
      const stat = fs.statSync(path.join(dir, f));
      return { name: f, size: stat.size, modified: stat.mtime.toISOString() };
    })
    .sort((a, b) => new Date(b.modified) - new Date(a.modified));
  res.json(files);
});

// Upload an EDI file (admin or pos)
app.post('/api/edi/:type/upload', requireAuth, ediUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  log(req.session.user.username, 'EDI_UPLOAD', `${req.params.type}: ${req.file.filename}`);
  res.json({ success: true, filename: req.file.filename });
});

// Download an EDI file
app.get('/api/edi/:type/download/:filename', requireAuth, (req, res) => {
  const { type, filename } = req.params;
  const dir = DIRS[type];
  if (!dir) return res.status(400).json({ error: 'Unknown type' });
  const fp = path.join(dir, filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File not found' });
  log(req.session.user.username, 'EDI_DOWNLOAD', `${type}: ${filename}`);
  res.download(fp, filename);
});

// Delete an EDI file (admin only)
app.delete('/api/edi/:type/:filename', requireAdmin, (req, res) => {
  const { type, filename } = req.params;
  const fp = path.join(DIRS[type], filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(fp);
  log(req.session.user.username, 'EDI_DELETE', `${type}: ${filename}`);
  res.json({ success: true });
});

// ─── Invoice → EDI 810 converter ─────────────────────────────────────────────
app.post('/api/invoice/convert', requireAuth, invoiceUpload.single('invoice'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { originalname, path: filePath, mimetype } = req.file;
  log(req.session.user.username, 'INVOICE_UPLOAD', originalname);

  // Read file content to pass to AI
  let fileContent = '';
  let isImage = false;
  let base64Data = '';
  let mediaType = '';

  const ext = path.extname(originalname).toLowerCase();
  if (ext === '.csv' || ext === '.txt') {
    fileContent = fs.readFileSync(filePath, 'utf8');
  } else if (ext === '.pdf' || ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
    base64Data = fs.readFileSync(filePath).toString('base64');
    mediaType = mimetype;
    isImage = true;
  } else {
    fileContent = fs.readFileSync(filePath, 'utf8').substring(0, 5000);
  }

  // Call Claude API to parse invoice and generate EDI 810
  try {
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
    
    const systemPrompt = `You are an EDI X12 specialist for a convenience store. 
Convert the provided invoice into a valid ANSI X12 EDI 810 (Invoice) transaction set.

IMPORTANT RULES:
- Use standard X12 004010 version
- Segment delimiter: ~
- Element delimiter: *
- Generate realistic ISA/GS envelope segments
- Use qualifier ZZ for sender/receiver IDs
- Sender ID: STORERETAIL
- Receiver ID: ORDERDOGPOS
- Include proper ST/SE transaction set control
- Line items should use IT1 segments with UPC codes
- Include TDS (Total Invoice Amount) in summary
- Return ONLY the raw EDI text, no explanation, no markdown fences

If you cannot read certain fields clearly, use placeholder values like UNKNOWN or 0.00`;

    let userContent;
    if (isImage) {
      userContent = [
        {
          type: ext === '.pdf' ? 'document' : 'image',
          source: { type: 'base64', media_type: mediaType, data: base64Data }
        },
        { type: 'text', text: 'Convert this invoice to EDI 810 format.' }
      ];
    } else {
      userContent = `Convert this invoice to EDI 810 format:\n\n${fileContent}`;
    }

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }]
      })
    });

    const aiData = await apiRes.json();
    const ediContent = aiData.content?.[0]?.text || '';

    if (!ediContent) {
      return res.status(500).json({ error: 'AI conversion failed', detail: JSON.stringify(aiData) });
    }

    // Save generated 810 file
    const outName = `810_${Date.now()}_converted.edi`;
    const outPath = path.join(DIRS['810'], outName);
    fs.writeFileSync(outPath, ediContent);
    log(req.session.user.username, 'EDI_810_GENERATED', `From: ${originalname} → ${outName}`);

    res.json({ success: true, filename: outName, preview: ediContent.substring(0, 800) });
  } catch (err) {
    console.error('AI error:', err);
    res.status(500).json({ error: 'Conversion error: ' + err.message });
  }
});

// ─── Admin: user management ──────────────────────────────────────────────────
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = getUsers().map(({ password, ...u }) => u);
  res.json(users);
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { username, password, role, name } = req.body;
  const users = getUsers();
  if (users.find(u => u.username === username)) return res.status(400).json({ error: 'Username taken' });
  const newUser = { id: Date.now(), username, password: bcrypt.hashSync(password, 10), role, name };
  users.push(newUser);
  saveUsers(users);
  log(req.session.user.username, 'USER_CREATED', username);
  res.json({ success: true });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  let users = getUsers();
  const target = users.find(u => u.id == req.params.id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  users = users.filter(u => u.id != req.params.id);
  saveUsers(users);
  log(req.session.user.username, 'USER_DELETED', target.username);
  res.json({ success: true });
});

// ─── Audit log ───────────────────────────────────────────────────────────────
app.get('/api/admin/logs', requireAdmin, (req, res) => {
  const logs = JSON.parse(fs.readFileSync(LOG_FILE));
  res.json(logs.slice(0, 200));
});

// ─── Stats ────────────────────────────────────────────────────────────────────
app.get('/api/stats', requireAuth, (req, res) => {
  const stats = {};
  ['850','997','855','810','catalog'].forEach(t => {
    const dir = DIRS[t];
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => !f.startsWith('.')) : [];
    stats[t] = files.length;
  });
  res.json(stats);
});

// ─── Serve SPA ────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`EDI Portal running on port ${PORT}`));
