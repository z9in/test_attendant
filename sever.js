const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// DB 연결 및 테이블 초기화
const db = new sqlite3.Database('./database.sqlite');

db.serialize(() => {
    // 사용자 테이블
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('super_admin', 'site_admin', 'user')),
        site_id INTEGER,
        mac_address TEXT,
        pending_mac TEXT,
        mac_status TEXT DEFAULT 'APPROVED',
        birth_date TEXT,
        assigned_date TEXT,
        closed_date TEXT,
        duty_type TEXT DEFAULT '상황실 대원'
    )`);

    // 출퇴근 기록 테이블
    db.run(`CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        clock_in TEXT NOT NULL,
        clock_out TEXT,
        status TEXT NOT NULL, -- IN, OUT, AUTO_OUT
        mac_address TEXT,
        memo TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    // 월간 근무 스케줄 테이블
    db.run(`CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        work_date TEXT NOT NULL, -- YYYY-MM-DD
        shift_code TEXT NOT NULL, -- A, B, C, D, E, F, G, H 등
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);
});

// Express 미들웨어
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'secret-key-attendance-system',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8시간
}));

// 인증 미들웨어
function isAuthenticated(req, res, next) {
    if (req.session && req.session.user) {
        return next();
    }
    res.status(401).json({ error: '로그인이 필요합니다.' });
}

// --------------------------------------------------
// 1. 로그인 / 로그아웃 API
// --------------------------------------------------
app.post('/login', (req, res) => {
    const { userId, password, deviceMac } = req.body;

    db.get(`SELECT * FROM users WHERE user_id = ? AND password = ?`, [userId, password], (err, user) => {
        if (err || !user) {
            return res.status(400).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
        }

        // 최초 로그인 시 MAC 자동 등록 처리
        if (!user.mac_address) {
            db.run(`UPDATE users SET mac_address = ?, mac_status = 'APPROVED' WHERE id = ?`, [deviceMac, user.id]);
            user.mac_address = deviceMac;
            user.mac_status = 'APPROVED';
        }

        req.session.user = {
            id: user.id,
            user_id: user.user_id,
            name: user.name,
            role: user.role,
            mac_address: user.mac_address,
            mac_status: user.mac_status
        };

        res.json({ success: true, user: req.session.user });
    });
});

app.post('/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/me', isAuthenticated, (req, res) => {
    db.get(`SELECT id, user_id, name, role, mac_address, pending_mac, mac_status FROM users WHERE id = ?`, 
    [req.session.user.id], (err, user) => {
        res.json(user);
    });
});

// --------------------------------------------------
// 2. MAC 주소/기기 변경 신청 및 승인 API
// --------------------------------------------------
app.post('/api/mac/request', isAuthenticated, (req, res) => {
    const { deviceMac } = req.body;
    const userId = req.session.user.id;

    db.get(`SELECT mac_address FROM users WHERE id = ?`, [userId], (err, user) => {
        if (!user.mac_address) {
            db.run(`UPDATE users SET mac_address = ?, mac_status = 'APPROVED' WHERE id = ?`, [deviceMac, userId], (err) => {
                res.json({ success: true, message: '기기가 성공적으로 등록되었습니다.' });
            });
        } else {
            db.run(`UPDATE users SET pending_mac = ?, mac_status = 'PENDING' WHERE id = ?`, [deviceMac, userId], (err) => {
                res.json({ success: true, message: '기기 변경 승인 요청이 완료되었습니다. 관리자 승인 후 사용 가능합니다.' });
            });
        }
    });
});

app.get('/api/mac/requests', isAuthenticated, (req, res) => {
    if (req.session.user.role === 'user') return res.status(403).json({ error: '권한이 없습니다.' });

    db.all(`SELECT id, name, mac_address, pending_mac FROM users WHERE mac_status = 'PENDING'`, [], (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/mac/approve', isAuthenticated, (req, res) => {
    if (req.session.user.role === 'user') return res.status(403).json({ error: '권한이 없습니다.' });
    const { userId, approve } = req.body;

    if (approve) {
        db.run(`UPDATE users SET mac_address = pending_mac, pending_mac = NULL, mac_status = 'APPROVED' WHERE id = ?`, [userId], (err) => {
            res.json({ success: true, message: '기기 변경이 승인되었습니다.' });
        });
    } else {
        db.run(`UPDATE users SET pending_mac = NULL, mac_status = 'REJECTED' WHERE id = ?`, [userId], (err) => {
            res.json({ success: true, message: '기기 변경 요청을 거절했습니다.' });
        });
    }
});

// --------------------------------------------------
// 3. 야간 대응 출/퇴근 등록 API (기기 식별자 검증)
// --------------------------------------------------
app.post('/api/attendance', isAuthenticated, (req, res) => {
    const { type, deviceMac } = req.body;
    const userId = req.session.user.id;

    db.get(`SELECT mac_address FROM users WHERE id = ?`, [userId], (err, user) => {
        if (err || !user) return res.status(500).json({ error: '사용자 정보 조회 실패' });

        // 타인 기기 등록 제재 (MAC 주소 일치 검증)
        if (user.mac_address && user.mac_address !== deviceMac) {
            return res.status(403).json({ error: '등록되지 않은 기기입니다. 타인의 기기로 출/퇴근할 수 없습니다.' });
        }

        const now = new Date();

        if (type === 'CLOCK_IN') {
            // 미퇴근 건이 있는지 확인
            db.get(`SELECT id FROM attendance WHERE user_id = ? AND status = 'IN'`, [userId], (err, activeIn) => {
                if (activeIn) {
                    return res.status(400).json({ error: '이미 출근 처리된 상태입니다. 이전 퇴근 기록을 먼저 확인하세요.' });
                }

                db.run(`INSERT INTO attendance (user_id, clock_in, status, mac_address) VALUES (?, ?, 'IN', ?)`, 
                [userId, now.toISOString(), deviceMac], (err) => {
                    res.json({ success: true, message: '출근 등록이 완료되었습니다.' });
                });
            });

        } else if (type === 'CLOCK_OUT') {
            // 자정을 넘기더라도 '가장 최근 미퇴근(IN) 건'을 찾아 퇴근 처리
            db.get(`SELECT id, clock_in FROM attendance WHERE user_id = ? AND status = 'IN' ORDER BY clock_in DESC LIMIT 1`, 
            [userId], (err, activeIn) => {
                if (!activeIn) {
                    return res.status(400).json({ error: '출근 기록이 없습니다. 먼저 출근 등록을 해주세요.' });
                }

                db.run(`UPDATE attendance SET clock_out = ?, status = 'OUT' WHERE id = ?`, 
                [now.toISOString(), activeIn.id], (err) => {
                    res.json({ success: true, message: '퇴근 등록이 완료되었습니다.' });
                });
            });
        }
    });
});

// --------------------------------------------------
// 4. 상황실 근무 상황 기록부 (월간 데이터 조회 API)
// --------------------------------------------------
app.get('/api/schedule/monthly-report', isAuthenticated, (req, res) => {
    const month = req.query.month; // YYYY-MM
    
    db.all(`SELECT id, name, duty_type, birth_date, assigned_date, closed_date FROM users ORDER BY id ASC`, [], (err, users) => {
        if (err) return res.status(500).json({ error: 'DB 오류' });

        db.all(`SELECT user_id, strftime('%d', work_date) as day, shift_code FROM schedules WHERE work_date LIKE ?`, 
        [`${month}%`], (err, schedules) => {
            
            const userScheduleMap = {};
            (schedules || []).forEach(s => {
                if (!userScheduleMap[s.user_id]) userScheduleMap[s.user_id] = {};
                userScheduleMap[s.user_id][s.day] = s.shift_code;
            });

            const result = users.map(u => ({
                ...u,
                schedules: userScheduleMap[u.id] || {}
            }));

            res.json({ users: result });
        });
    });
});

// --------------------------------------------------
// 5. [자동 퇴근 스케줄러] 30분마다 체크하여 16시간 이상 미퇴근 건 자동 퇴근 처리
// --------------------------------------------------
setInterval(() => {
    const now = new Date();

    db.all(`SELECT id, clock_in FROM attendance WHERE status = 'IN'`, [], (err, rows) => {
        if (err || !rows) return;

        rows.forEach(row => {
            const clockInTime = new Date(row.clock_in);
            const diffHours = (now - clockInTime) / (1000 * 60 * 60);

            // 야간 근무(15시간) 감안, 출근 후 16시간 경과 시 자동 퇴근 처리
            if (diffHours >= 16) {
                // 출근 시각 + 15시간을 정시 퇴근 시각으로 산정
                const autoClockOut = new Date(clockInTime.getTime() + (15 * 60 * 60 * 1000));

                db.run(`UPDATE attendance SET clock_out = ?, status = 'AUTO_OUT', memo = '16시간 초과 시스템 자동 퇴근' WHERE id = ?`, 
                [autoClockOut.toISOString(), row.id], (err) => {
                    console.log(`[Auto-Clock-Out] ID ${row.id} 번 출근건이 자동 퇴근 처리되었습니다.`);
                });
            }
        });
    });
}, 30 * 60 * 1000); // 30분 주기 실행

// 서버 실행
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
