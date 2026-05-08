require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { Parser } = require('json2csv');
const multer = require('multer');
const xlsx = require('xlsx');
const fs = require('fs');
const nodemailer = require('nodemailer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.socket.io", "https://fonts.googleapis.com"],
            scriptSrcAttr: ["'self'", "'unsafe-inline'", "'unsafe-hashes'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            connectSrc: ["'self'", "ws:", "wss:", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:"],
        }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
    originAgentCluster: false
}));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: 'Слишком много запросов' });
app.use(limiter);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/mixora.db', (req, res) => res.status(403).send('Доступ запрещён'));
app.use('/uploads', (req, res) => res.status(403).send('Доступ запрещён'));

const upload = multer({ dest: 'uploads/' });
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads', { recursive: true });

// ========== ПОЧТА (MAIL.RU) ==========
let transporter = null;
if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log('⚠️  EMAIL_USER или EMAIL_PASS не заданы. Коды будут в консоли.');
} else {
    transporter = nodemailer.createTransport({
        host: 'smtp.mail.ru',
        port: 465,
        secure: true,
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });
    console.log('✅ Почта настроена (Mail.ru).');
}

// ========== БАЗА ДАННЫХ ==========
try { fs.unlinkSync('mixora.db'); } catch(e) {} // ВРЕМЕННО! Удалить после первого деплоя!
const db = new Database('mixora.db');
db.pragma('foreign_keys = ON');

db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'bartender', email_verified INTEGER DEFAULT 0,
    verification_code TEXT, login_attempts INTEGER DEFAULT 0, blocked_until TEXT
)`);
db.exec(`CREATE TABLE IF NOT EXISTS manager_bartenders (id INTEGER PRIMARY KEY AUTOINCREMENT, manager_id INTEGER NOT NULL, bartender_id INTEGER NOT NULL, created_at TEXT DEFAULT '', FOREIGN KEY(manager_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY(bartender_id) REFERENCES users(id) ON DELETE CASCADE, UNIQUE(manager_id, bartender_id))`);
db.exec(`CREATE TABLE IF NOT EXISTS bars (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, address TEXT DEFAULT '', type TEXT DEFAULT 'bar', created_by INTEGER, created_at TEXT DEFAULT '', FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL)`);
db.exec(`CREATE TABLE IF NOT EXISTS user_bars (user_id INTEGER, bar_id INTEGER, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY(bar_id) REFERENCES bars(id) ON DELETE CASCADE, PRIMARY KEY(user_id, bar_id))`);
db.exec(`CREATE TABLE IF NOT EXISTS inventory_items (id INTEGER PRIMARY KEY AUTOINCREMENT, bar_id INTEGER, name TEXT NOT NULL, unit TEXT DEFAULT 'л', category TEXT DEFAULT 'alcohol', sealed_count REAL DEFAULT 0, sealed_volume REAL DEFAULT 0.7, opened_count REAL DEFAULT 0, opened_volume REAL DEFAULT 0.7, opened_remainder REAL DEFAULT 0, total_volume REAL DEFAULT 0, previous_total REAL DEFAULT 0, broken_count INTEGER DEFAULT 0, FOREIGN KEY(bar_id) REFERENCES bars(id) ON DELETE CASCADE)`);
db.exec(`CREATE TABLE IF NOT EXISTS inventory_dates (bar_id INTEGER, last_inventory_date TEXT, FOREIGN KEY(bar_id) REFERENCES bars(id) ON DELETE CASCADE, PRIMARY KEY(bar_id))`);

function validateEmail(email) { return /^.{5,}@.+\..+$/.test(email); }
function validatePassword(password) { return password.length >= 6 && /[a-zA-Z]/.test(password) && /[0-9]/.test(password); }
function validateName(name) { return name && name.trim().length >= 2 && name.trim().length <= 50; }
function escapeHtml(str) { return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function isBlocked(user) { if (!user.blocked_until) return false; return new Date() < new Date(user.blocked_until + 'Z'); }
function generateCode() { return Math.floor(100000 + Math.random() * 900000).toString(); }

const DEFAULT_TEMPLATE = [
    { name:'Водка', unit:'л', cat:'alcohol' }, { name:'Виски', unit:'л', cat:'alcohol' },
    { name:'Джин', unit:'л', cat:'alcohol' }, { name:'Ром', unit:'л', cat:'alcohol' },
    { name:'Текила', unit:'л', cat:'alcohol' }, { name:'Апероль', unit:'л', cat:'alcohol' },
    { name:'Вино красное', unit:'л', cat:'wine' }, { name:'Вино белое', unit:'л', cat:'wine' },
    { name:'Игристое', unit:'л', cat:'wine' }, { name:'Пиво светлое', unit:'л', cat:'beer' },
    { name:'Пиво тёмное', unit:'л', cat:'beer' }, { name:'Кег пивной 30л', unit:'л', cat:'beer' },
    { name:'Сок апельсиновый', unit:'л', cat:'drinks' }, { name:'Кола', unit:'л', cat:'drinks' },
    { name:'Тоник', unit:'л', cat:'drinks' }, { name:'Вода', unit:'л', cat:'drinks' },
    { name:'Лимоны', unit:'кг', cat:'ingredients' }, { name:'Лайм', unit:'кг', cat:'ingredients' },
    { name:'Мята', unit:'кг', cat:'ingredients' }, { name:'Лёд', unit:'кг', cat:'ingredients' },
    { name:'Сироп ванильный', unit:'л', cat:'ingredients' },
    { name:'Бокалы для вина', unit:'шт', cat:'dishes' }, { name:'Бокалы для шампанского', unit:'шт', cat:'dishes' },
    { name:'Стаканы', unit:'шт', cat:'dishes' }, { name:'Тарелки', unit:'шт', cat:'dishes' }
];

function getBarsForUser(userId, role) {
    if (role==='manager') return db.prepare(`SELECT DISTINCT b.id,b.name,b.address,b.type,b.created_by,COALESCE(d.last_inventory_date,'Никогда') as last_inventory_date,u.name as created_by_name FROM bars b LEFT JOIN inventory_dates d ON b.id=d.bar_id LEFT JOIN users u ON b.created_by=u.id WHERE b.created_by=? OR b.created_by IN (SELECT bartender_id FROM manager_bartenders WHERE manager_id=?) ORDER BY b.name`).all(userId,userId);
    return db.prepare(`SELECT DISTINCT b.id,b.name,b.address,b.type,b.created_by,COALESCE(d.last_inventory_date,'Никогда') as last_inventory_date,u.name as created_by_name FROM bars b JOIN user_bars ub ON b.id=ub.bar_id LEFT JOIN inventory_dates d ON b.id=d.bar_id LEFT JOIN users u ON b.created_by=u.id WHERE ub.user_id=? ORDER BY b.name`).all(userId);
}
function sendEmail(to, subject, html) {
    if (!transporter) { console.log(`[EMAIL ОТКЛЮЧЁН] ${to}`); return false; }
    transporter.sendMail({ from: `"Mixora" <${process.env.EMAIL_USER}>`, to, subject, html })
        .then(() => console.log(`[EMAIL ОТПРАВЛЕН] ${to}`))
        .catch(e => console.error(`[EMAIL ОШИБКА] ${to}:`, e.message));
    return true;
}

app.post('/upload-inventory', upload.single('file'), (req, res) => {
    try {
        if(!req.file) return res.status(400).json({error:'Нет файла'});
        const barId=parseInt(req.body.barId); if(!barId) return res.status(400).json({error:'Нет barId'});
        const fp=req.file.path, ext=path.extname(req.file.originalname).toLowerCase();
        let rows=[];
        if(ext==='.csv') rows=fs.readFileSync(fp,'utf-8').split('\n').map(l=>l.split(','));
        else if(ext==='.xlsx'||ext==='.xls') { const wb=xlsx.readFile(fp); rows=xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1}); }
        else { fs.unlinkSync(fp); return res.status(400).json({error:'Только CSV/Excel'}); }
        const sw=['инвентаризация','концепция','комментарий','излишки','недостача','наименований:','итого','товар','себестоимость','факт','книжн','разница','сумма','page'];
        const isStop=r=>{if(!r||!r.length)return true;const f=String(r[0]||'').toLowerCase().trim();if(!f||f.length<2)return true;for(const w of sw)if(f.includes(w))return true;return /^[^а-яa-z]/i.test(f);};
        const isCat=r=>r.filter(c=>c&&String(c).trim()!=='').length===1;
        const guessUnit=n=>{const l=n.toLowerCase();if(/(^|\s)кг(\s|$)/.test(l)||l.includes(', кг')||l.endsWith('кг'))return'кг';if(/(^|\s)шт(\s|$)/.test(l)||l.includes('бут')||l.includes('банк')||l.includes('бокал')||l.includes('тарелк')||l.includes('стакан')||l.includes('прибор'))return'шт';const kg=['лимоны','лайм','апельсины','мята','сахар','соль','перец','чеснок','вишня','клубника','стружка','мед','кислота','ванильный','паприка','специи','корица','гвоздика','бадьян','чай','матча','пуэр','ромашка','персики','лёд','лед'];for(const k of kg)if(l.includes(k))return'кг';if(l.includes('пиво')&&!l.includes('бут')&&!l.includes('банк'))return'л';return'л';};
        const guessCat=(n,u)=>{const l=n.toLowerCase();if(u==='шт')return'dishes';if(l.includes('пиво')||l.includes('кег'))return'beer';if(l.includes('вин')||l.includes('игрист')||l.includes('порт')||l.includes('вермут'))return'wine';if(l.includes('сок')||l.includes('кола')||l.includes('тоник')||l.includes('вода')||l.includes('лимонад')||l.includes('напиток'))return'drinks';if(l.includes('лимон')||l.includes('лайм')||l.includes('мята')||l.includes('лёд')||l.includes('лед')||l.includes('сироп')||l.includes('пюре')||l.includes('спец')||l.includes('сахар')||l.includes('соль'))return'ingredients';return'alcohol';};
        const clean=n=>String(n||'').trim().replace(/,?\s*(кг|л|шт)\.?\s*$/i,'').trim();
        const items=[],seen=new Set();
        for(const row of rows){if(!row||!row.length)continue;if(isStop(row))continue;if(isCat(row))continue;const name=String(row[0]||'').trim();if(!name||name.length<2)continue;const factQty=parseFloat(row[5])||0,bookQty=parseFloat(row[7])||0;if(factQty===0&&bookQty===0)continue;const unit=guessUnit(name),cl=clean(name),cat=guessCat(cl,unit),key=cl.toLowerCase();if(seen.has(key))continue;seen.add(key);items.push({name:cl,unit,cat,total_volume:factQty,previous_total:Math.abs(bookQty),sealed_count:0,sealed_volume:0.7,opened_count:0,opened_volume:0.7,opened_remainder:0,broken_count:0});}
        fs.unlinkSync(fp);
        if(!items.length)return res.status(400).json({error:'Позиций не найдено'});
        const del=db.prepare('DELETE FROM inventory_items WHERE bar_id=?');
        const ins=db.prepare('INSERT INTO inventory_items (bar_id,name,unit,category,sealed_count,sealed_volume,opened_count,opened_volume,opened_remainder,total_volume,previous_total,broken_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
        db.transaction(()=>{del.run(barId);for(const i of items)ins.run(barId,i.name,i.unit,i.cat,i.sealed_count,i.sealed_volume,i.opened_count,i.opened_volume,i.opened_remainder,i.total_volume,i.previous_total,i.broken_count);})();
        res.json({success:true,count:items.length,items:db.prepare('SELECT * FROM inventory_items WHERE bar_id=? ORDER BY name').all(barId)});
    } catch(e){console.error(e);try{fs.unlinkSync(req.file.path);}catch(_){}res.status(500).json({error:e.message});}
});
app.get('/download-template',(_,res)=>{res.setHeader('Content-Type','text/csv;charset=utf-8');res.setHeader('Content-Disposition','attachment;filename=Mixora_Шаблон.csv');res.send('Название,Категория,Закр.кол-во,Закр.объём,Вскр.кол-во,Вскр.остаток,Битых,Общий остаток,Ед.изм,Было\nВодка Finlandia,alcohol,3,0.7,2,0.3,0,2.7,л,3.5');});

io.on('connection', socket => {
    const clientIp = socket.handshake.address;
    console.log(`+ ${socket.id} (${clientIp})`);

    socket.on('register', data => {
        if (!validateEmail(data.email)) return socket.emit('errorMessage', 'Некорректный email.');
        if (!validatePassword(data.password)) return socket.emit('errorMessage', 'Пароль: мин. 6 символов, буквы + цифры.');
        if (!validateName(data.name)) return socket.emit('errorMessage', 'Имя: от 2 до 50 символов.');
        try {
            const hash = bcrypt.hashSync(data.password, 10);
            const role = data.role || 'bartender';
            const code = generateCode();
            if (db.prepare('SELECT id FROM users WHERE email = ?').get(data.email)) return socket.emit('errorMessage', 'Пользователь с таким email уже существует.');
            db.prepare('INSERT INTO users (name, email, password, role, email_verified, verification_code) VALUES (?, ?, ?, ?, 0, ?)').run(escapeHtml(data.name), data.email, hash, role, code);
            console.log(`\n============================================\n  КОД ПОДТВЕРЖДЕНИЯ для ${data.email}: ${code}\n============================================\n`);
            sendEmail(data.email, 'Mixora — Код подтверждения', `<h2>Добро пожаловать в Mixora!</h2><p>Ваш код: <b style="font-size:24px;color:#D4A843;">${code}</b></p>`);
            socket.emit('verificationRequired', { email: data.email });
        } catch (e) { console.error('Ошибка регистрации:', e.message); socket.emit('errorMessage', 'Ошибка регистрации.'); }
    });

    socket.on('resendCode', data => {
        const user = db.prepare('SELECT * FROM users WHERE email = ? AND email_verified = 0').get(data.email);
        if (!user) return socket.emit('errorMessage', 'Пользователь не найден или уже подтверждён.');
        const newCode = generateCode();
        db.prepare('UPDATE users SET verification_code = ? WHERE id = ?').run(newCode, user.id);
        sendEmail(data.email, 'Mixora — Новый код', `<h2>Новый код подтверждения</h2><p>Ваш код: <b style="font-size:24px;color:#D4A843;">${newCode}</b></p>`);
        console.log(`\n=== НОВЫЙ КОД ДЛЯ ${data.email}: ${newCode} ===\n`);
    });

    socket.on('verifyEmail', data => {
        const user = db.prepare('SELECT * FROM users WHERE email = ? AND email_verified = 0').get(data.email);
        if (!user) return socket.emit('errorMessage', 'Не найден или уже подтверждён.');
        if (user.verification_code !== data.code) return socket.emit('errorMessage', 'Неверный код. Нажмите "Отправить повторно".');
        db.prepare('UPDATE users SET email_verified = 1, verification_code = NULL WHERE id = ?').run(user.id);
        if (user.role === 'bartender') {
            const br = db.prepare("INSERT INTO bars (name,address,type,created_by,created_at) VALUES (?,?,?,?,datetime('now','localtime'))").run('Мой бар', 'Адрес не указан', 'bar', user.id);
            db.prepare('INSERT INTO user_bars (user_id,bar_id) VALUES (?,?)').run(user.id, br.lastInsertRowid);
            const st = db.prepare('INSERT INTO inventory_items (bar_id,name,unit,category,sealed_count,sealed_volume,opened_count,opened_volume,opened_remainder,total_volume,previous_total,broken_count) VALUES (?,?,?,?,0,0.7,0,0.7,0,0,0,0)');
            for (const t of DEFAULT_TEMPLATE) st.run(br.lastInsertRowid, t.name, t.unit, t.cat);
        }
        socket.emit('registrationSuccess');
    });

    socket.on('login', data => {
        const user = db.prepare('SELECT * FROM users WHERE email = ?').get(data.email);
        if (!user) return socket.emit('errorMessage', 'Неверный email или пароль.');
        if (isBlocked(user)) { const mins = Math.ceil((new Date(user.blocked_until + 'Z') - new Date()) / 60000); return socket.emit('errorMessage', `Аккаунт заблокирован. Попробуйте через ${mins} мин.`); }
        if (!user.email_verified) return socket.emit('errorMessage', 'Email не подтверждён.');
        if (data.savedSession && user) { db.prepare('UPDATE users SET login_attempts = 0, blocked_until = NULL WHERE id = ?').run(user.id); return socket.emit('loginSuccess', { user: { id: user.id, name: user.name, email: user.email, role: user.role }, bars: getBarsForUser(user.id, user.role) }); }
        if (!bcrypt.compareSync(data.password, user.password)) {
            const attempts = (user.login_attempts || 0) + 1;
            if (attempts >= 5) { db.prepare("UPDATE users SET login_attempts = ?, blocked_until = datetime('now', '+15 minutes') WHERE id = ?").run(attempts, user.id); return socket.emit('errorMessage', 'Аккаунт заблокирован на 15 минут.'); }
            db.prepare('UPDATE users SET login_attempts = ? WHERE id = ?').run(attempts, user.id);
            return socket.emit('errorMessage', `Неверный пароль. Осталось попыток: ${5 - attempts}`);
        }
        db.prepare('UPDATE users SET login_attempts = 0, blocked_until = NULL WHERE id = ?').run(user.id);
        socket.emit('loginSuccess', { user: { id: user.id, name: user.name, email: user.email, role: user.role }, bars: getBarsForUser(user.id, user.role) });
    });

    socket.on('getBarsList', d => socket.emit('barsList', getBarsForUser(d.userId, d.role)));
    socket.on('addBar', data => { const r = db.prepare("INSERT INTO bars (name,address,type,created_by,created_at) VALUES (?,?,?,?,datetime('now','localtime'))").run(escapeHtml(data.name), escapeHtml(data.address), data.type, data.userId); const barId = r.lastInsertRowid; db.prepare('INSERT OR IGNORE INTO user_bars (user_id,bar_id) VALUES (?,?)').run(data.userId, barId); const st = db.prepare('INSERT INTO inventory_items (bar_id,name,unit,category,sealed_count,sealed_volume,opened_count,opened_volume,opened_remainder,total_volume,previous_total,broken_count) VALUES (?,?,?,?,0,0.7,0,0.7,0,0,0,0)'); for (const t of DEFAULT_TEMPLATE) st.run(barId, t.name, t.unit, t.cat); const u = db.prepare('SELECT role FROM users WHERE id=?').get(data.userId); socket.emit('barsList', getBarsForUser(data.userId, u.role)); });
    socket.on('renameBar', data => { db.prepare('UPDATE bars SET name=? WHERE id=?').run(escapeHtml(data.newName), data.barId); socket.emit('barRenamed', data); });
    socket.on('deleteBar', data => { db.prepare('DELETE FROM bars WHERE id=?').run(data.barId); socket.emit('barsList', getBarsForUser(data.userId, data.role)); });
    socket.on('getMyBartenders', data => { socket.emit('myBartenders', db.prepare('SELECT u.id,u.name,u.email FROM users u JOIN manager_bartenders mb ON u.id=mb.bartender_id WHERE mb.manager_id=? ORDER BY u.name').all(data.managerId)); });
    socket.on('addBartender', data => { const b = db.prepare("SELECT id,name,email FROM users WHERE email=? AND role='bartender'").get(data.bartenderEmail); if (!b) { socket.emit('errorMessage', 'Бармен не найден'); return; } if (db.prepare('SELECT id FROM manager_bartenders WHERE manager_id=? AND bartender_id=?').get(data.managerId, b.id)) { socket.emit('errorMessage', 'Уже в команде'); return; } db.prepare("INSERT INTO manager_bartenders (manager_id,bartender_id,created_at) VALUES (?,?,datetime('now','localtime'))").run(data.managerId, b.id); const bars = db.prepare('SELECT id FROM bars WHERE created_by=?').all(data.managerId); const lnk = db.prepare('INSERT OR IGNORE INTO user_bars (user_id,bar_id) VALUES (?,?)'); for (const bar of bars) lnk.run(b.id, bar.id); const m = db.prepare('SELECT name FROM users WHERE id=?').get(data.managerId); sendEmail(b.email, 'Вас добавили в Mixora!', `<h2>Привет, ${b.name}!</h2><p>Менеджер <b>${m.name}</b> добавил вас в команду.</p>`); socket.emit('myBartenders', db.prepare('SELECT u.id,u.name,u.email FROM users u JOIN manager_bartenders mb ON u.id=mb.bartender_id WHERE mb.manager_id=? ORDER BY u.name').all(data.managerId)); socket.emit('successMessage', `Бармен ${b.name} добавлен!`); });
    socket.on('selectBar', data => { const bar = db.prepare('SELECT * FROM bars WHERE id=?').get(data.barId); const items = db.prepare('SELECT * FROM inventory_items WHERE bar_id=? ORDER BY category, name').all(data.barId); socket.emit('barInventory', { barId: data.barId, barName: bar.name, items }); });
    socket.on('addItem', data => { db.prepare('INSERT INTO inventory_items (bar_id,name,unit,category,sealed_count,sealed_volume,opened_count,opened_volume,opened_remainder,total_volume,previous_total,broken_count) VALUES (?,?,?,?,0,0.7,0,0.7,0,0,0,0)').run(data.barId, escapeHtml(data.name), data.unit, data.category||'alcohol'); socket.emit('inventoryUpdated', db.prepare('SELECT * FROM inventory_items WHERE bar_id=? ORDER BY category, name').all(data.barId)); });
    socket.on('updateItem', data => { db.prepare('UPDATE inventory_items SET name=?,unit=?,category=?,sealed_count=?,sealed_volume=?,opened_count=?,opened_volume=?,opened_remainder=?,total_volume=?,broken_count=? WHERE id=?').run(escapeHtml(data.name), data.unit, data.category||'alcohol', data.sealed_count||0, data.sealed_volume||0.7, data.opened_count||0, data.opened_volume||0.7, data.opened_remainder||0, data.total_volume||0, data.broken_count||0, data.itemId); socket.emit('inventoryUpdated', db.prepare('SELECT * FROM inventory_items WHERE bar_id=? ORDER BY category, name').all(data.barId)); });
    socket.on('deleteItem', data => { db.prepare('DELETE FROM inventory_items WHERE id=?').run(data.itemId); socket.emit('inventoryUpdated', db.prepare('SELECT * FROM inventory_items WHERE bar_id=? ORDER BY category, name').all(data.barId)); });
    socket.on('saveInventory', data => { const st = db.prepare('UPDATE inventory_items SET sealed_count=?,sealed_volume=?,opened_count=?,opened_volume=?,opened_remainder=?,total_volume=?,broken_count=? WHERE id=?'); db.transaction(() => { for (const i of data.items) st.run(i.sealed_count||0, i.sealed_volume||0.7, i.opened_count||0, i.opened_volume||0.7, i.opened_remainder||0, i.total_volume||0, i.broken_count||0, i.id); })(); db.prepare('UPDATE inventory_items SET previous_total=total_volume WHERE bar_id=?').run(data.barId); db.prepare("INSERT OR REPLACE INTO inventory_dates (bar_id,last_inventory_date) VALUES (?,datetime('now','localtime'))").run(data.barId); socket.emit('inventorySaved', db.prepare('SELECT * FROM inventory_items WHERE bar_id=? ORDER BY category, name').all(data.barId)); });
    socket.on('exportInventory', data => { const items = db.prepare('SELECT name,category,sealed_count,sealed_volume,opened_count,opened_remainder,broken_count,total_volume,unit,previous_total FROM inventory_items WHERE bar_id=? ORDER BY category, name').all(data.barId); const bar = db.prepare('SELECT name FROM bars WHERE id=?').get(data.barId); const csv = new Parser({ fields: ['name','category','sealed_count','sealed_volume','opened_count','opened_remainder','broken_count','total_volume','unit','previous_total'] }).parse(items); socket.emit('exportReady', { csv, filename: `Mixora_${bar.name}_${new Date().toISOString().slice(0,10)}.csv` }); });
    socket.on('disconnect', () => console.log(`- ${socket.id}`));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Mixora v1.02 запущена на порту ${PORT}`));