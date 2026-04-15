const express = require('express');
const multer  = require('multer');
const session = require('express-session');
const bcrypt  = require('bcryptjs');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const BASE = {
  vendors: path.join(__dirname, 'vendors'),
  uploads: path.join(__dirname, 'uploads'),
  data:    path.join(__dirname, 'data'),
};
Object.values(BASE).forEach(d => fs.mkdirSync(d, { recursive: true }));

const FOLDERS = ['in', 'out', 'catalog', 'test'];

// ─── Vendors ──────────────────────────────────────────────────────────────────
const VENDORS_FILE = path.join(BASE.data, 'vendors.json');
function getVendors() {
  if (!fs.existsSync(VENDORS_FILE)) {
    const defaults = [
      { id: 'mclane',    name: 'McLane',             created: new Date().toISOString() },
      { id: 'northstar', name: 'Northstar Wholesale', created: new Date().toISOString() },
    ];
    fs.writeFileSync(VENDORS_FILE, JSON.stringify(defaults, null, 2));
  }
  return JSON.parse(fs.readFileSync(VENDORS_FILE));
}
function saveVendors(v) { fs.writeFileSync(VENDORS_FILE, JSON.stringify(v, null, 2)); }
function ensureVendorDirs(vendorId) {
  FOLDERS.forEach(f => fs.mkdirSync(path.join(BASE.vendors, vendorId, f), { recursive: true }));
}
getVendors().forEach(v => ensureVendorDirs(v.id));

// ─── Users ────────────────────────────────────────────────────────────────────
const USERS_FILE = path.join(BASE.data, 'users.json');
if (!fs.existsSync(USERS_FILE) || process.env.RESET_USERS === 'true') {
  fs.writeFileSync(USERS_FILE, JSON.stringify([
    { id: 1, username: 'admin',    password: bcrypt.hashSync('admin123', 10), role: 'admin', name: 'Store Admin',   permissions: { folders: ['in','out','catalog','test'], canUpload: true,  canDelete: true  } },
    { id: 2, username: 'orderdog', password: bcrypt.hashSync('pospass1',  10), role: 'pos',   name: 'OrderDog POS', permissions: { folders: ['in','out','catalog','test'], canUpload: false, canDelete: false } },
  ], null, 2));
}
function getUsers() { return JSON.parse(fs.readFileSync(USERS_FILE)); }
function saveUsers(u) { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2)); }

// ─── Audit log ────────────────────────────────────────────────────────────────
const LOG_FILE = path.join(BASE.data, 'audit.json');
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '[]');
function log(user, action, detail) {
  const logs = JSON.parse(fs.readFileSync(LOG_FILE));
  logs.unshift({ ts: new Date().toISOString(), user, action, detail });
  if (logs.length > 500) logs.splice(500);
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'edi-portal-secret-2025',
  resave: false, saveUninitialized: false,
  cookie: { secure: false, maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Multer ───────────────────────────────────────────────────────────────────
const fileUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const { vendorId, folder } = req.params;
      const dir = path.join(BASE.vendors, vendorId, folder);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`)
  }),
  limits: { fileSize: 25 * 1024 * 1024 }
});

const invoiceUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, BASE.uploads),
    filename:    (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`)
  }),
  limits: { fileSize: 25 * 1024 * 1024 }
});

// ─── Auth helpers ─────────────────────────────────────────────────────────────
function requireAuth(req, res, next)  { if (req.session?.user) return next(); res.status(401).json({ error: 'Not authenticated' }); }
function requireAdmin(req, res, next) { if (req.session?.user?.role === 'admin') return next(); res.status(403).json({ error: 'Admin only' }); }

function canAccessFolder(user, folder) {
  if (user.role === 'admin') return true;
  const users = getUsers();
  const fullUser = users.find(u => u.id === user.id);
  const perms = fullUser?.permissions || { folders: ['out', 'catalog'] };
  return (perms.folders || []).includes(folder);
}

function canUpload(user) {
  if (user.role === 'admin') return true;
  const users = getUsers();
  const fullUser = users.find(u => u.id === user.id);
  return fullUser?.permissions?.canUpload === true;
}

function canDelete(user) {
  if (user.role === 'admin') return true;
  const users = getUsers();
  const fullUser = users.find(u => u.id === user.id);
  return fullUser?.permissions?.canDelete === true;
}

// ─── Auth routes ──────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = getUsers().find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    log(username, 'LOGIN_FAIL', 'Bad credentials');
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  req.session.user = { id: user.id, username: user.username, role: user.role, name: user.name };
  log(user.username, 'LOGIN', 'Success');
  res.json({ success: true, role: user.role, name: user.name, permissions: user.permissions });
});

app.post('/api/logout', (req, res) => {
  if (req.session.user) log(req.session.user.username, 'LOGOUT', '');
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  const users = getUsers();
  const user  = users.find(u => u.id === req.session.user.id);
  res.json({ ...req.session.user, permissions: user?.permissions });
});

// ─── Vendor routes ────────────────────────────────────────────────────────────
app.get('/api/vendors', requireAuth, (req, res) => res.json(getVendors()));

app.post('/api/vendors', requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = name.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/__+/g, '_').replace(/^_|_$/g, '');
  const vendors = getVendors();
  if (vendors.find(v => v.id === id)) return res.status(400).json({ error: 'Vendor already exists' });
  const vendor = { id, name, created: new Date().toISOString() };
  vendors.push(vendor);
  saveVendors(vendors);
  ensureVendorDirs(id);
  log(req.session.user.username, 'VENDOR_CREATED', name);
  res.json({ success: true, vendor });
});

app.delete('/api/vendors/:vendorId', requireAdmin, (req, res) => {
  const { vendorId } = req.params;
  let vendors = getVendors();
  if (!vendors.find(v => v.id === vendorId)) return res.status(404).json({ error: 'Not found' });
  vendors = vendors.filter(v => v.id !== vendorId);
  saveVendors(vendors);
  log(req.session.user.username, 'VENDOR_DELETED', vendorId);
  res.json({ success: true });
});

// ─── File routes ──────────────────────────────────────────────────────────────
app.get('/api/vendors/:vendorId/:folder', requireAuth, (req, res) => {
  const { vendorId, folder } = req.params;
  if (!FOLDERS.includes(folder)) return res.status(400).json({ error: 'Invalid folder' });
  if (!canAccessFolder(req.session.user, folder)) return res.status(403).json({ error: 'Access denied' });
  const dir = path.join(BASE.vendors, vendorId, folder);
  fs.mkdirSync(dir, { recursive: true });
  const files = fs.readdirSync(dir)
    .filter(f => !f.startsWith('.'))
    .map(f => {
      const stat = fs.statSync(path.join(dir, f));
      return { name: f, size: stat.size, modified: stat.mtime.toISOString() };
    })
    .sort((a, b) => new Date(b.modified) - new Date(a.modified));
  res.json(files);
});

app.post('/api/vendors/:vendorId/:folder/upload', requireAuth, (req, res, next) => {
  if (!canUpload(req.session.user)) return res.status(403).json({ error: 'Upload not permitted' });
  next();
}, fileUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const { vendorId, folder } = req.params;
  log(req.session.user.username, 'FILE_UPLOAD', `${vendorId}/${folder}: ${req.file.filename}`);
  res.json({ success: true, filename: req.file.filename });
});

app.get('/api/vendors/:vendorId/:folder/download/:filename', requireAuth, (req, res) => {
  const { vendorId, folder, filename } = req.params;
  if (!canAccessFolder(req.session.user, folder)) return res.status(403).json({ error: 'Access denied' });
  const fp = path.join(BASE.vendors, vendorId, folder, filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  log(req.session.user.username, 'FILE_DOWNLOAD', `${vendorId}/${folder}: ${filename}`);
  res.download(fp, filename);
});

app.delete('/api/vendors/:vendorId/:folder/:filename', requireAuth, (req, res) => {
  if (!canDelete(req.session.user)) return res.status(403).json({ error: 'Delete not permitted' });
  const { vendorId, folder, filename } = req.params;
  const fp = path.join(BASE.vendors, vendorId, folder, filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(fp);
  log(req.session.user.username, 'FILE_DELETE', `${vendorId}/${folder}: ${filename}`);
  res.json({ success: true });
});

// ─── Invoice converter ────────────────────────────────────────────────────────
app.post('/api/convert', requireAdmin, invoiceUpload.single('invoice'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { vendorId } = req.body;
  if (!vendorId) return res.status(400).json({ error: 'Vendor required' });
  const { originalname, path: filePath, mimetype } = req.file;
  log(req.session.user.username, 'INVOICE_UPLOAD', `${vendorId}: ${originalname}`);
  const ext = path.extname(originalname).toLowerCase();
  let userContent;
  if (ext === '.csv' || ext === '.txt') {
    const text = fs.readFileSync(filePath, 'utf8');
    userContent = `Convert this wholesale invoice CSV to EDI 810. CSV columns: InvoiceNo, Date, UPC, Qty, Cost, Retail, Discount, Flag, ItemNo, Description\n\n${text}`;
  } else if (['.pdf','.png','.jpg','.jpeg'].includes(ext)) {
    const b64 = fs.readFileSync(filePath).toString('base64');
    userContent = [
      { type: ext === '.pdf' ? 'document' : 'image', source: { type: 'base64', media_type: mimetype, data: b64 } },
      { type: 'text', text: 'Convert this invoice to EDI 810 format.' }
    ];
  } else {
    userContent = `Convert this invoice to EDI 810:\n\n${fs.readFileSync(filePath,'utf8').substring(0,5000)}`;
  }
  const systemPrompt = `You are an EDI X12 specialist for a convenience store. Convert the provided vendor invoice into a valid ANSI X12 EDI 810 Invoice transaction set. Rules: X12 004010 version, segment delimiter ~, element delimiter *, qualifier ZZ, Sender ID STORERETAIL, Receiver ID ORDERDOGPOS, include ST/SE control, line items use IT1 segments with UPC in VP qualifier, include TDS total. Return ONLY raw EDI text, no explanation, no markdown.`;
  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 4000, system: systemPrompt, messages: [{ role: 'user', content: userContent }] })
    });
    const aiData = await apiRes.json();
    console.log('Anthropic status:', apiRes.status, JSON.stringify(aiData).substring(0,200));
    const ediContent = aiData.content?.[0]?.text || '';
    if (!ediContent) return res.status(500).json({ error: 'AI conversion failed', detail: JSON.stringify(aiData) });
    const outDir = path.join(BASE.vendors, vendorId, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const outName = `810_${Date.now()}_${originalname.replace(/\.[^.]+$/,'')}.edi`;
    fs.writeFileSync(path.join(outDir, outName), ediContent);
    log(req.session.user.username, 'EDI_810_GENERATED', `${vendorId}/out: ${outName}`);
    res.json({ success: true, filename: outName, vendorId, preview: ediContent.substring(0,800) });
  } catch(err) {
    console.error('Convert error:', err);
    res.status(500).json({ error: 'Conversion error: ' + err.message });
  }
});

// ─── Stats ────────────────────────────────────────────────────────────────────
app.get('/api/stats', requireAuth, (req, res) => {
  const vendors = getVendors();
  const stats = {};
  vendors.forEach(v => {
    stats[v.id] = {};
    FOLDERS.forEach(f => {
      const dir = path.join(BASE.vendors, v.id, f);
      stats[v.id][f] = fs.existsSync(dir) ? fs.readdirSync(dir).filter(x => !x.startsWith('.')).length : 0;
    });
  });
  res.json(stats);
});

// ─── Admin: users ─────────────────────────────────────────────────────────────
app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json(getUsers().map(({ password, ...u }) => u));
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { username, password, role, name, permissions } = req.body;
  const users = getUsers();
  if (users.find(u => u.username === username)) return res.status(400).json({ error: 'Username taken' });
  const defaultPerms = role === 'admin'
    ? { folders: ['in','out','catalog','test'], canUpload: true,  canDelete: true  }
    : { folders: ['in','out','catalog','test'], canUpload: false, canDelete: false };
  users.push({ id: Date.now(), username, password: bcrypt.hashSync(password, 10), role, name, permissions: permissions || defaultPerms });
  saveUsers(users);
  log(req.session.user.username, 'USER_CREATED', username);
  res.json({ success: true });
});

app.put('/api/admin/users/:id/permissions', requireAdmin, (req, res) => {
  const users = getUsers();
  const idx   = users.findIndex(u => u.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  users[idx].permissions = req.body.permissions;
  saveUsers(users);
  log(req.session.user.username, 'PERMISSIONS_UPDATED', users[idx].username);
  res.json({ success: true });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  let users = getUsers();
  const target = users.find(u => u.id == req.params.id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  const remainingAdmins = users.filter(u => u.role === 'admin' && u.id != req.params.id);
  if (remainingAdmins.length === 0 && target.role === 'admin') return res.status(403).json({ error: 'Cannot delete only admin' });
  users = users.filter(u => u.id != req.params.id);
  saveUsers(users);
  log(req.session.user.username, 'USER_DELETED', target.username);
  res.json({ success: true });
});

// ─── Admin: logs ──────────────────────────────────────────────────────────────
app.get('/api/admin/logs', requireAdmin, (req, res) => {
  res.json(JSON.parse(fs.readFileSync(LOG_FILE)).slice(0,200));
});

// ─── SPA ──────────────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`EDI Portal running on port ${PORT}`));
