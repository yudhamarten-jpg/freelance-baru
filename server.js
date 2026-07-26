const express = require('express');
const session = require('express-session');

const bodyParser = require('body-parser');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Database Setup ────────────────────────────────────────────
const Database = require('better-sqlite3');
const db = new Database('./database.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Buat Tabel ────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    discord_name TEXT DEFAULT '',
    wa_number TEXT DEFAULT '',
    dana_number TEXT DEFAULT '',
    referral_code TEXT UNIQUE,
    referred_by TEXT DEFAULT '',
    referral_earnings INTEGER DEFAULT 0,
    total_earnings INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS otp_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    type TEXT DEFAULT 'register',
    expires_at DATETIME NOT NULL,
    used INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS setoran (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    discord_name TEXT DEFAULT '',
    wa_number TEXT DEFAULT '',
    dana_number TEXT DEFAULT '',
    email_usernames TEXT NOT NULL,
    jumlah_email INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',
    alasan TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (member_id) REFERENCES members(id)
  );

  CREATE TABLE IF NOT EXISTS data_emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    diterima_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (member_id) REFERENCES members(id)
  );

  CREATE TABLE IF NOT EXISTS pencairan (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    jumlah INTEGER NOT NULL,
    metode TEXT DEFAULT 'DANA',
    nomor_tujuan TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (member_id) REFERENCES members(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS statistik_harian (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tanggal TEXT NOT NULL,
    total_setoran INTEGER DEFAULT 0,
    pending INTEGER DEFAULT 0,
    accepted INTEGER DEFAULT 0,
    denied INTEGER DEFAULT 0,
    total_bayaran INTEGER DEFAULT 0
  );
`);

// ─── Settings Default ──────────────────────────────────────────
const getSetting = (key, defaultVal) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultVal;
};

const setSetting = (key, value) => {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
};

// Default settings
if (!getSetting('open_time')) setSetting('open_time', '00:00');
if (!getSetting('close_time')) setSetting('close_time', '23:59');
if (!getSetting('harga_per_email')) setSetting('harga_per_email', '2000');
if (!getSetting('referral_bonus')) setSetting('referral_bonus', '500');

// ─── Middleware ─────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: __dirname }),
  secret: process.env.SESSION_SECRET || 'default-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// ─── Middleware Auth ────────────────────────────────────────────
const requireMember = (req, res, next) => {
  if (req.session.memberId) return next();
  res.redirect('/member-login');
};

const requireAdmin = (req, res, next) => {
  if (req.session.isAdmin) return next();
  res.redirect('/admin-login');
};

// ─── Helpers ────────────────────────────────────────────────────
const generateOTP = () => crypto.randomInt(100000, 999999).toString();
const generateReferralCode = () => 'REF' + crypto.randomBytes(4).toString('hex').toUpperCase();

function isSetoranOpen() {
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const openTime = getSetting('open_time', '00:00');
  const closeTime = getSetting('close_time', '23:59');
  const [oh, om] = openTime.split(':').map(Number);
  const [ch, cm] = closeTime.split(':').map(Number);
  const openMinutes = oh * 60 + om;
  const closeMinutes = ch * 60 + cm;
  return currentMinutes >= openMinutes && currentMinutes <= closeMinutes;
}

function getServerTime() {
  const now = new Date();
  return {
    date: now.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    time: now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    timestamp: now.getTime()
  };
}

// ─── ROUTES: Landing ────────────────────────────────────────────
app.get('/', (req, res) => {
  const stats = {
    members: db.prepare('SELECT COUNT(*) as c FROM members').get().c,
    setoran: db.prepare('SELECT COUNT(*) as c FROM setoran').get().c,
    accepted: db.prepare("SELECT COUNT(*) as c FROM setoran WHERE status='accepted'").get().c
  };
  res.render('landing', { stats, serverTime: getServerTime() });
});

// ─── ROUTES: Member Auth ────────────────────────────────────────
app.get('/member-login', (req, res) => {
  res.render('member-login', { error: null, success: null });
});

app.post('/member-login', (req, res) => {
  const { username, password } = req.body;
  const member = db.prepare('SELECT * FROM members WHERE username = ?').get(username);
  if (!member || member.password !== password) {
    return res.render('member-login', { error: 'Username atau password salah!', success: null });
  }
  req.session.memberId = member.id;
  req.session.memberName = member.username;
  res.redirect('/member-dashboard');
});

app.get('/member-register', (req, res) => {
  res.render('member-register', { error: null, success: null });
});

app.post('/member-register', (req, res) => {
  const { username, email, password, confirm_password, referral_code } = req.body;
  
  if (password !== confirm_password) {
    return res.render('member-register', { error: 'Password tidak cocok!', success: null });
  }

  const existing = db.prepare('SELECT * FROM members WHERE username = ? OR email = ?').get(username, email);
  if (existing) {
    return res.render('member-register', { error: 'Username atau email sudah terdaftar!', success: null });
  }

  // Generate OTP
  const otp = generateOTP();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  
  db.prepare('DELETE FROM otp_codes WHERE email = ? AND type = ?').run(email, 'register');
  db.prepare('INSERT INTO otp_codes (email, code, type, expires_at) VALUES (?, ?, ?, ?)').run(email, otp, 'register', expiresAt);

  // Simpan data sementara di session
  req.session.tempRegister = { username, email, password, referral_code: referral_code || '' };

  // Kirim email (TODO: setup nodemailer)
  console.log(`[OTP REGISTER] Email: ${email}, Kode: ${otp}`);

  res.render('member-verify-otp', { email, error: null, type: 'register' });
});

app.post('/member-verify-otp', (req, res) => {
  const { email, otp } = req.body;
  const temp = req.session.tempRegister;
  
  if (!temp || temp.email !== email) {
    return res.render('member-verify-otp', { email, error: 'Sesi pendaftaran habis. Silakan daftar ulang.', type: 'register' });
  }

  const otpRecord = db.prepare(
    "SELECT * FROM otp_codes WHERE email = ? AND type = 'register' AND used = 0 AND expires_at > ? ORDER BY id DESC LIMIT 1"
  ).get(email, new Date().toISOString());

  if (!otpRecord || otpRecord.code !== otp) {
    return res.render('member-verify-otp', { email, error: 'Kode OTP salah atau kadaluarsa!', type: 'register' });
  }

  db.prepare('UPDATE otp_codes SET used = 1 WHERE id = ?').run(otpRecord.id);

  // Buat member
  const refCode = generateReferralCode();
  let referredBy = '';

  if (temp.referral_code) {
    const refMember = db.prepare('SELECT * FROM members WHERE referral_code = ?').get(temp.referral_code);
    if (refMember) referredBy = temp.referral_code;
  }

  db.prepare(
    'INSERT INTO members (username, email, password, referral_code, referred_by) VALUES (?, ?, ?, ?, ?)'
  ).run(temp.username, temp.email, temp.password, refCode, referredBy);

  delete req.session.tempRegister;

  res.render('member-login', { error: null, success: 'Registrasi berhasil! Silakan login.' });
});

app.get('/member-logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ─── ROUTES: Admin Auth ─────────────────────────────────────────
app.get('/admin-login', (req, res) => {
  res.render('admin-login', { error: null });
});

app.post('/admin-login', (req, res) => {
  const { password } = req.body;
  if (password === (process.env.ADMIN_PASSWORD || 'yudha05')) {
    req.session.isAdmin = true;
    res.redirect('/admin-dashboard');
  } else {
    res.render('admin-login', { error: 'Password admin salah!' });
  }
});

app.get('/admin-logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ─── ROUTES: Member Dashboard ───────────────────────────────────
app.get('/member-dashboard', requireMember, (req, res) => {
  const memberId = req.session.memberId;
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);

  // Statistik
  const totalSetoran = db.prepare('SELECT COUNT(*) as c FROM setoran WHERE member_id = ?').get(memberId).c;
  const pending = db.prepare("SELECT COUNT(*) as c FROM setoran WHERE member_id = ? AND status='pending'").get(memberId).c;
  const accepted = db.prepare("SELECT COUNT(*) as c FROM setoran WHERE member_id = ? AND status='accepted'").get(memberId).c;
  const denied = db.prepare("SELECT COUNT(*) as c FROM setoran WHERE member_id = ? AND status='denied'").get(memberId).c;

  const riwayatSetoran = db.prepare(
    'SELECT * FROM setoran WHERE member_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(memberId);

  const riwayatPencairan = db.prepare(
    'SELECT * FROM pencairan WHERE member_id = ? ORDER BY created_at DESC LIMIT 20'
  ).all(memberId);

  const dataEmails = db.prepare(
    'SELECT * FROM data_emails WHERE member_id = ? ORDER BY diterima_at DESC LIMIT 20'
  ).all(memberId);

  const hargaPerEmail = parseInt(getSetting('harga_per_email', '2000'));

  res.render('member-dashboard', {
    member,
    stats: { totalSetoran, pending, accepted, denied },
    riwayatSetoran,
    riwayatPencairan,
    dataEmails,
    hargaPerEmail,
    isSetoranOpen: isSetoranOpen(),
    serverTime: getServerTime()
  });
});

// ─── Member: Setor Email ────────────────────────────────────────
app.post('/member-setor', requireMember, (req, res) => {
  if (!isSetoranOpen()) {
    return res.json({ success: false, message: 'Setoran sedang ditutup!' });
  }

  const memberId = req.session.memberId;
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
  const { emails } = req.body; // email usernames dipisah baris/enter

  if (!emails || !emails.trim()) {
    return res.json({ success: false, message: 'Email tidak boleh kosong!' });
  }

  const emailList = emails.split('\n').map(e => e.trim()).filter(e => e);
  
  db.prepare(
    'INSERT INTO setoran (member_id, discord_name, wa_number, dana_number, email_usernames, jumlah_email) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(memberId, member.discord_name, member.wa_number, member.dana_number, JSON.stringify(emailList), emailList.length);

  res.json({ success: true, message: `Berhasil menyetor ${emailList.length} email!` });
});

// ─── Member: Update Profil ──────────────────────────────────────
app.post('/member-update-profil', requireMember, (req, res) => {
  const memberId = req.session.memberId;
  const { discord_name, wa_number, dana_number } = req.body;
  db.prepare('UPDATE members SET discord_name = ?, wa_number = ?, dana_number = ? WHERE id = ?')
    .run(discord_name, wa_number, dana_number, memberId);
  res.redirect('/member-dashboard');
});

// ─── Member: Request Pencairan ──────────────────────────────────
app.post('/member-pencairan', requireMember, (req, res) => {
  const memberId = req.session.memberId;
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);

  if (member.total_earnings <= 0) {
    return res.json({ success: false, message: 'Belum ada saldo yang bisa dicairkan!' });
  }

  db.prepare(
    'INSERT INTO pencairan (member_id, jumlah, metode, nomor_tujuan) VALUES (?, ?, ?, ?)'
  ).run(memberId, member.total_earnings, 'DANA', member.dana_number);

  // Kurangi saldo
  db.prepare('UPDATE members SET total_earnings = 0 WHERE id = ?').run(memberId);

  res.json({ success: true, message: 'Permintaan pencairan berhasil dikirim!' });
});

// ─── ROUTES: Admin Dashboard ────────────────────────────────────
app.get('/admin-dashboard', requireAdmin, (req, res) => {
  const members = db.prepare('SELECT * FROM members ORDER BY created_at DESC').all();
  const setoran = db.prepare(`
    SELECT s.*, m.username, m.discord_name as member_discord, m.wa_number as member_wa
    FROM setoran s JOIN members m ON s.member_id = m.id
    ORDER BY s.created_at DESC
  `).all();

  const pencairan = db.prepare(`
    SELECT p.*, m.username, m.dana_number
    FROM pencairan p JOIN members m ON p.member_id = m.id
    ORDER BY p.created_at DESC
  `).all();

  // Statistik
  const totalMembers = members.length;
  const totalSetoran = db.prepare('SELECT COUNT(*) as c FROM setoran').get().c;
  const pending = db.prepare("SELECT COUNT(*) as c FROM setoran WHERE status='pending'").get().c;
  const accepted = db.prepare("SELECT COUNT(*) as c FROM setoran WHERE status='accepted'").get().c;
  const denied = db.prepare("SELECT COUNT(*) as c FROM setoran WHERE status='denied'").get().c;
  const totalBayaran = db.prepare("SELECT COALESCE(SUM(jumlah), 0) as c FROM pencairan WHERE status='selesai'").get().c;

  res.render('admin-dashboard', {
    members,
    setoran,
    pencairan,
    stats: { totalMembers, totalSetoran, pending, accepted, denied, totalBayaran },
    settings: {
      openTime: getSetting('open_time', '00:00'),
      closeTime: getSetting('close_time', '23:59'),
      hargaPerEmail: getSetting('harga_per_email', '2000'),
      referralBonus: getSetting('referral_bonus', '500')
    },
    serverTime: getServerTime()
  });
});

// ─── Admin: Kelola Member ───────────────────────────────────────
app.post('/admin-delete-member', requireAdmin, (req, res) => {
  const { memberId } = req.body;
  db.prepare('DELETE FROM pencairan WHERE member_id = ?').run(memberId);
  db.prepare('DELETE FROM data_emails WHERE member_id = ?').run(memberId);
  db.prepare('DELETE FROM setoran WHERE member_id = ?').run(memberId);
  db.prepare('DELETE FROM members WHERE id = ?').run(memberId);
  res.redirect('/admin-dashboard');
});

// ─── Admin: Input Data Email ────────────────────────────────────
app.post('/admin-input-email', requireAdmin, (req, res) => {
  const { member_id, emails_data } = req.body;
  // emails_data format: username:password per baris
  const lines = emails_data.split('\n').map(l => l.trim()).filter(l => l && l.includes(':'));
  
  const insert = db.prepare('INSERT INTO data_emails (member_id, username, password) VALUES (?, ?, ?)');
  const insertMany = db.transaction((lines) => {
    for (const line of lines) {
      const [username, password] = line.split(':');
      insert.run(member_id, username.trim(), password.trim());
    }
  });
  insertMany(lines);

  res.redirect('/admin-dashboard');
});

// ─── Admin: Update Status Setoran ───────────────────────────────
app.post('/admin-update-setoran', requireAdmin, (req, res) => {
  const { setoranId, status, alasan } = req.body;
  const setoranRecord = db.prepare('SELECT * FROM setoran WHERE id = ?').get(setoranId);
  
  if (!setoranRecord) return res.redirect('/admin-dashboard');

  db.prepare('UPDATE setoran SET status = ?, alasan = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(status, alasan || '', setoranId);

  // Jika accepted, tambahkan earning ke member
  if (status === 'accepted') {
    const hargaPerEmail = parseInt(getSetting('harga_per_email', '2000'));
    const earning = setoranRecord.jumlah_email * hargaPerEmail;
    db.prepare('UPDATE members SET total_earnings = total_earnings + ? WHERE id = ?')
      .run(earning, setoranRecord.member_id);

    // Referral bonus
    const member = db.prepare('SELECT * FROM members WHERE id = ?').get(setoranRecord.member_id);
    if (member.referred_by) {
      const referralBonus = parseInt(getSetting('referral_bonus', '500'));
      db.prepare('UPDATE members SET referral_earnings = referral_earnings + ?, total_earnings = total_earnings + ? WHERE referral_code = ?')
        .run(referralBonus, referralBonus, member.referred_by);
    }
  }

  res.redirect('/admin-dashboard');
});

// ─── Admin: Update Status Pencairan ─────────────────────────────
app.post('/admin-update-pencairan', requireAdmin, (req, res) => {
  const { pencairanId, status } = req.body;
  db.prepare('UPDATE pencairan SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(status, pencairanId);
  res.redirect('/admin-dashboard');
});

// ─── Admin: Update Settings ──────────────────────────────────────
app.post('/admin-update-settings', requireAdmin, (req, res) => {
  const { open_time, close_time, harga_per_email, referral_bonus } = req.body;
  if (open_time) setSetting('open_time', open_time);
  if (close_time) setSetting('close_time', close_time);
  if (harga_per_email) setSetting('harga_per_email', harga_per_email);
  if (referral_bonus) setSetting('referral_bonus', referral_bonus);
  res.redirect('/admin-dashboard');
});

// ─── Admin: Auto-Reset Statistik ────────────────────────────────
app.post('/admin-reset-stats', requireAdmin, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const pending = db.prepare("SELECT COUNT(*) as c FROM setoran WHERE status='pending'").get().c;
  const accepted = db.prepare("SELECT COUNT(*) as c FROM setoran WHERE status='accepted'").get().c;
  const denied = db.prepare("SELECT COUNT(*) as c FROM setoran WHERE status='denied'").get().c;
  const totalSetoran = db.prepare('SELECT COUNT(*) as c FROM setoran').get().c;
  const totalBayaran = db.prepare("SELECT COALESCE(SUM(jumlah),0) as c FROM pencairan WHERE status='selesai'").get().c;

  db.prepare(`INSERT OR REPLACE INTO statistik_harian (tanggal, total_setoran, pending, accepted, denied, total_bayaran)
    VALUES (?, ?, ?, ?, ?, ?)`).run(today, totalSetoran, pending, accepted, denied, totalBayaran);

  res.redirect('/admin-dashboard');
});

// ─── API: Server Time ───────────────────────────────────────────
app.get('/api/server-time', (req, res) => {
  res.json(getServerTime());
});

// ─── API: Check Status Setoran (public) ─────────────────────────
app.get('/api/check-status', (req, res) => {
  const { query } = req.query;
  if (!query) return res.json({ error: 'Masukkan Discord name atau WA number' });

  const results = db.prepare(`
    SELECT s.*, m.username 
    FROM setoran s JOIN members m ON s.member_id = m.id
    WHERE s.discord_name LIKE ? OR s.wa_number LIKE ? OR m.discord_name LIKE ? OR m.wa_number LIKE ?
    ORDER BY s.created_at DESC LIMIT 20
  `).all(`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`);

  res.json({ results });
});

// ─── Start Server ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server Freelance Baru berjalan di http://localhost:${PORT}`);
});
