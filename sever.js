const express = require('express');
const bodyParser = require('body-parser');
const db = require('./database');
const session = require('express-session');

const app = express();

// HTML 파일을 뷰 엔진으로 설정 (ejs의 renderFile 활용)
app.engine('html', require('ejs').renderFile);
app.set('view engine', 'html');

app.use(express.static('public')); // CSS, JS 등 정적 파일을 위한 폴더 설정
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true })); // 폼 데이터 처리를 위한 설정 추가

// 세션 설정
app.use(session({
    secret: 'attendance-key',
    resave: false,
    saveUninitialized: false
}));

// 인증 미들웨어
const isAuthenticated = (req, res, next) => {
    if (req.session.user) next();
    else {
        if (req.originalUrl.startsWith('/api/')) {
            res.status(401).json({ success: false, message: "세션이 만료되었습니다." });
        } else {
            res.redirect('/login');
        }
    }
};

// 로그인 페이지
app.get('/login', (req, res) => {
    res.render('login');
});

// 로그인 처리
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM employees WHERE username = ? AND password = ?", [username, password], (err, user) => {
        if (err) return res.status(500).json({ success: false, message: "DB 에러 발생" });
        if (user) {
            req.session.user = { id: user.id, name: user.name, role: user.role, site_id: user.site_id };
            res.json({ success: true, role: user.role });
        } else {
            res.status(401).json({ success: false, message: "아이디 또는 비밀번호가 틀렸습니다." });
        }
    });
});

// 로그아웃
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// 사용자 페이지
app.get('/', isAuthenticated, (req, res) => {
    res.render('index'); // SPA 통합 페이지인 index.html을 메인으로 사용
});

// 내 정보 및 오늘 스케줄 조회 API
app.get('/api/user/me', isAuthenticated, (req, res) => {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
    const query = `
        SELECT e.name, e.department, e.position, e.role, e.site_id as managed_site_id, ms.name as managed_site_name,
               s.name as site_name, s.latitude, s.longitude, wp.start_time, wp.end_time, wp.pattern_name,
               al.check_in_time, al.check_out_time, al.status as attendance_status
        FROM employees e
        LEFT JOIN sites ms ON e.site_id = ms.id
        LEFT JOIN employee_schedules es ON e.id = es.employee_id AND ? BETWEEN es.start_date AND IFNULL(es.end_date, '9999-12-31')
        LEFT JOIN work_patterns wp ON es.pattern_id = wp.id
        LEFT JOIN sites s ON wp.site_id = s.id
        LEFT JOIN attendance_logs al ON e.id = al.employee_id AND al.work_date = ?
        WHERE e.id = ?`;
    db.get(query, [today, today, req.session.user.id], (err, row) => {
        if (err) {
            console.error("Error fetching user info:", err);
            return res.status(500).json({ error: err.message });
        }
        // 세션의 role 정보를 최종 응답에 포함시켜 클라이언트에서 사용하도록 합니다.
        res.json({ ...row, role: req.session.user.role, site_id: row.managed_site_id, site_name: row.managed_site_name || row.site_name });
    });
});

// [관리자] 대시보드 통계
app.get('/api/admin/dashboard', isAuthenticated, (req, res) => {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
    const stats = {};
    db.get("SELECT COUNT(*) as total FROM employee_schedules WHERE ? BETWEEN start_date AND IFNULL(end_date, '9999-12-31')", [today], (err, row) => {
        stats.target = row.total;
        db.get("SELECT COUNT(DISTINCT employee_id) as done FROM attendance_logs WHERE work_date = ?", [today], (err, row2) => {
            stats.completed = row2.done;
            stats.late = stats.target - stats.completed;
            res.json(stats);
        });
    });
});

// [관리자] 현장 및 패턴 관리
app.get('/api/admin/sites', (req, res) => {
    if (req.session.user.role !== 'super_admin') return res.status(403).json({ success: false, message: "권한이 없습니다." });
    db.all("SELECT * FROM sites", [], (err, sites) => {
        if (err) return res.status(500).json({ error: err.message });
        db.all("SELECT * FROM work_patterns", [], (err, patterns) => {
            if (err) return res.status(500).json({ error: err.message });
            const result = sites.map(s => ({
                ...s,
                patterns: patterns.filter(p => p.site_id === s.id)
            }));
            res.json(result);
        });
    });
});

app.post('/api/admin/sites', (req, res) => {
    if (req.session.user.role !== 'super_admin') return res.status(403).json({ success: false, message: "권한이 없습니다." });
    const { id, name, address, lat, lng, patterns } = req.body;
    
    // 패턴 저장을 처리하는 공통 비동기 함수
    const savePatterns = (siteId, callback) => {
        db.run(`DELETE FROM work_patterns WHERE site_id = ?`, [siteId], (err) => {
            if (err) return callback(err);
            if (!patterns || patterns.length === 0) return callback(null);
            
            let completed = 0;
            let hasError = false;
            patterns.forEach(p => {
                db.run(`INSERT INTO work_patterns (site_id, pattern_name, start_time, end_time, rest_time) VALUES (?, ?, ?, ?, ?)`, // DB 컬럼명과 일치
                    [siteId, p.name, p.start_time, p.end_time, p.rest_time || 0], (err) => { // 클라이언트에서 넘어온 속성명과 일치
                        if (hasError) return;
                        if (err) {
                            hasError = true;
                            return callback(err);
                        }
                        completed++;
                        // 모든 패턴이 저장된 후에만 콜백 실행
                        if (completed === patterns.length) {
                            callback(null);
                        }
                    });
            });
        });
    };

    if (id) {
        // 기존 현장 수정
        db.run(`UPDATE sites SET name = ?, address = ?, latitude = ?, longitude = ? WHERE id = ?`,
            [name, address, lat, lng, id], function(err) {
                if (err) return res.json({ success: false, message: err.message });
                savePatterns(id, (err) => {
                    if (err) return res.json({ success: false, message: err.message });
                    res.json({ success: true });
                });
            });
    } else {
        // 신규 현장 등록
        db.run(`INSERT INTO sites (name, address, latitude, longitude) VALUES (?, ?, ?, ?)`,
            [name, address, lat, lng], function(err) {
                if (err) return res.json({ success: false, message: err.message });
                const siteId = this.lastID;
                savePatterns(siteId, (err) => {
                    if (err) return res.json({ success: false, message: err.message });
                    res.json({ success: true });
                });
            });
    }
});

app.post('/api/admin/sites/delete', (req, res) => {
    if (req.session.user.role !== 'super_admin') return res.status(403).json({ success: false, message: "권한이 없습니다." });
    const { id } = req.body;
    // 패턴 먼저 삭제 후 현장 삭제
    db.run(`DELETE FROM work_patterns WHERE site_id = ?`, [id], (err) => {
        if (err) return res.json({ success: false, message: err.message });
        db.run(`DELETE FROM sites WHERE id = ?`, [id], (err) => {
            if (err) return res.json({ success: false, message: err.message });
            res.json({ success: true });
        });
    });
});

// [관리자] 근무자 관리
app.get('/api/admin/users', (req, res) => {
    if (!['super_admin', 'site_admin'].includes(req.session.user.role)) return res.status(403).json({ success: false, message: "권한이 없습니다." });
    db.all("SELECT * FROM employees", [], (err, rows) => res.json(rows));
});

app.post('/api/admin/users', (req, res) => {
    if (req.session.user.role !== 'super_admin') return res.status(403).json({ success: false, message: "권한이 없습니다." });
    const { id, username, password, name, department, position, site_id, role, isEdit } = req.body;

    if (isEdit) {
        // 근무자 정보 수정
        db.run(`UPDATE employees SET username = ?, password = ?, name = ?, department = ?, position = ?, site_id = ?, role = ? WHERE id = ?`,
            [username, password, name, department, position, site_id, role, id], (err) => {
                res.json({ success: !err, message: err ? err.message : "" });
            });
    } else {
        // 신규 근무자 등록
        db.run(`INSERT INTO employees (id, username, password, name, department, position, site_id, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, username, password, name, department, position, site_id, role], (err) => {
                res.json({ success: !err, message: err ? err.message : "" });
            });
    }
});

// [관리자] 근무자 삭제
app.post('/api/admin/users/delete', (req, res) => {
    if (req.session.user.role !== 'super_admin') return res.status(403).json({ success: false, message: "권한이 없습니다." });
    const { id } = req.body;
    db.run(`DELETE FROM employees WHERE id = ?`, [id], (err) => {
        if (err) return res.json({ success: false, message: err.message });
        res.json({ success: true });
    });
});

// [관리자] 근무 편성 관리
app.get('/api/admin/patterns', (req, res) => {
    const { role, site_id } = req.session.user;
    let query = `SELECT wp.*, s.name as site_name FROM work_patterns wp JOIN sites s ON wp.site_id = s.id`;
    let params = [];
    
    if (role === 'site_admin') {
        query += ` WHERE s.id = ?`;
        params.push(site_id);
    } else if (role !== 'super_admin') return res.status(403).json({ success: false, message: "권한이 없습니다." });

    db.all(query, params, (err, rows) => {
        if (err) {
            console.error("Error fetching work patterns:", err);
            return res.status(500).json({ success: false, message: "근무 패턴 목록 조회 실패" });
        }
        res.json(rows);
    });
});

app.post('/api/admin/schedules', (req, res) => {
    if (!['super_admin', 'site_admin'].includes(req.session.user.role)) return res.status(403).send('권한이 없습니다.');
    const { employee_id, pattern_id, start_date, end_date, type, extra_start, extra_end, rest_time } = req.body;
    
    // 연장(extra) 또는 대체(substitute) 근무는 'pending' 상태로 생성
    const status = (type === 'extra' || type === 'substitute') ? 'pending' : 'approved';

    db.run(`INSERT INTO employee_schedules (employee_id, pattern_id, start_date, end_date, type, status, extra_start, extra_end, rest_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [employee_id, pattern_id, start_date, end_date, type || 'normal', status, extra_start || null, extra_end || null, rest_time || 0], (err) => {
            res.json({ success: !err, message: err ? err.message : "" });
        });
});

// [관리자] 승인 대기 목록 조회
app.get('/api/admin/approvals', isAuthenticated, (req, res) => {
    if (req.session.user.role !== 'super_admin') return res.status(403).json({ success: false, message: "권한이 없습니다." });
    
    const query = `
        SELECT es.*, e.name as employee_name, wp.pattern_name, s.name as site_name, 
               wp.start_time as p_start, wp.end_time as p_end, wp.rest_time as p_rest
        FROM employee_schedules es
        JOIN employees e ON es.employee_id = e.id
        JOIN work_patterns wp ON es.pattern_id = wp.id
        JOIN sites s ON wp.site_id = s.id
        WHERE es.status = 'pending'
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// [관리자] 근무스케줄 현황 데이터 (특정 현장, 특정 월 기준)
app.get('/api/admin/schedule-status-data', isAuthenticated, (req, res) => {
    if (req.session.user.role !== 'super_admin') return res.status(403).json({ success: false });
    const { site_id, month } = req.query; // site_id, month: YYYY-MM

    // 해당 월의 앞뒤 주차 계산을 위해 넉넉하게 데이터를 가져옴 (전달 말일 ~ 다음달 초일 포함)
    const query = `
        SELECT es.*, e.name as employee_name, wp.pattern_name, wp.start_time, wp.end_time, wp.rest_time
        FROM employee_schedules es
        JOIN employees e ON es.employee_id = e.id
        JOIN work_patterns wp ON es.pattern_id = wp.id
        WHERE wp.site_id = ? AND (es.start_date LIKE ? OR es.start_date BETWEEN date(?, '-7 days') AND date(?, '+37 days'))
        AND es.status = 'approved'
    `;
    const monthPattern = `${month}%`;
    db.all(query, [site_id, monthPattern, month + '-01', month + '-01'], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// [관리자] 승인/거절 처리
app.post('/api/admin/approvals/process', isAuthenticated, (req, res) => {
    if (req.session.user.role !== 'super_admin') return res.status(403).json({ success: false, message: "권한이 없습니다." });
    const { id, status, reason } = req.body; // status: 'approved' or 'rejected'
    db.run(`UPDATE employee_schedules SET status = ?, rejection_reason = ? WHERE id = ?`, [status, reason || null, id], (err) => {
        if (err) return res.json({ success: false, message: err.message });
        res.json({ success: true });
    });
});

// [관리자] 근무 편성 삭제 API
app.get('/api/admin/schedules/delete/:id', isAuthenticated, (req, res) => {
    if (!['super_admin', 'site_admin'].includes(req.session.user.role)) return res.status(403).send('권한이 없습니다.');
    const { id } = req.params;
    db.run(`DELETE FROM employee_schedules WHERE id = ?`, [id], (err) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true });
    });
});

// [관리자] 전체 근무 편성 조회
app.get('/api/admin/schedules', isAuthenticated, (req, res) => {
    const { role, site_id } = req.session.user;
    if (!['super_admin', 'site_admin'].includes(role)) return res.status(403).send('권한이 없습니다.');

    let query = `
        SELECT es.*, e.name as employee_name, wp.pattern_name, wp.start_time, wp.end_time, wp.rest_time, s.name as site_name, s.id as site_id
        FROM employee_schedules es
        JOIN employees e ON es.employee_id = e.id
        JOIN work_patterns wp ON es.pattern_id = wp.id
        JOIN sites s ON wp.site_id = s.id
    `;
    let params = [];
    if (role === 'site_admin') {
        query += ` WHERE s.id = ?`;
        params.push(site_id);
    }
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// [관리자] 근태 현황 - 현장별 요약 (최고관리자용)
app.get('/api/admin/attendance/summary', isAuthenticated, (req, res) => {
    if (req.session.user.role !== 'super_admin') return res.status(403).json({ success: false });
    const { month } = req.query; // YYYY-MM 형식
    const query = `
        SELECT s.id, s.name, COUNT(al.id) as log_count
        FROM sites s
        LEFT JOIN attendance_logs al ON s.id = al.site_id AND al.work_date LIKE ?
        GROUP BY s.id
    `;
    db.all(query, [`${month}%`], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// [관리자] 근태 현황 - 상세 내역 (최고/현장관리자용)
app.get('/api/admin/attendance/details', isAuthenticated, (req, res) => {
    const { role, site_id: sessionSiteId } = req.session.user;
    if (!['super_admin', 'site_admin'].includes(role)) return res.status(403).json({ success: false });

    const { month, site_id } = req.query;
    const targetSiteId = role === 'site_admin' ? sessionSiteId : site_id;

    const query = `
        SELECT al.*, e.name as employee_name, wp.pattern_name, wp.start_time, wp.end_time
        FROM attendance_logs al
        JOIN employees e ON al.employee_id = e.id
        LEFT JOIN employee_schedules es ON al.employee_id = es.employee_id AND al.work_date BETWEEN es.start_date AND IFNULL(es.end_date, '9999-12-31')
        LEFT JOIN work_patterns wp ON es.pattern_id = wp.id
        WHERE al.site_id = ? AND al.work_date LIKE ?
        ORDER BY al.work_date DESC, al.check_in_time DESC
    `;
    db.all(query, [targetSiteId, `${month}%`], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// [사용자] 본인 근태 로그 조회 (달력 표시용)
app.get('/api/user/attendance-logs', isAuthenticated, (req, res) => {
    const { month } = req.query; // YYYY-MM
    db.all(`SELECT * FROM attendance_logs WHERE employee_id = ? AND work_date LIKE ?`, 
        [req.session.user.id, `${month}%`], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

// 하버사인 공식 (거리 계산)
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // 지구 반지름 (m)
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ/2) * Math.sin(Δλ/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// [사용자] 출퇴근 등록 API
app.post('/api/attendance', (req, res) => {
    if (!req.session.user) return res.json({ success: false, message: "로그인이 필요합니다." });
    
    const { type, lat, lng } = req.body;
    const employee_id = req.session.user.id;
    const now = new Date();
    // 한국 시간(KST) 기준 날짜 및 시간 계산 (타임존 고정)
    const work_date = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }); // YYYY-MM-DD
    const currentTime = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Seoul', hour12: false }).substring(0, 5); // HH:mm

    if (type === 'in') {
        // 출근: 오늘 날짜의 스케줄 조회
        const query = `
            SELECT s.latitude, s.longitude, s.id as site_id, IFNULL(es.extra_start, wp.start_time) as start_time 
            FROM employee_schedules es
            JOIN work_patterns wp ON es.pattern_id = wp.id
            JOIN sites s ON wp.site_id = s.id
            WHERE es.employee_id = ? AND ? BETWEEN es.start_date AND IFNULL(es.end_date, '9999-12-31') AND es.status = 'approved'`;

        db.get(query, [employee_id, work_date], (err, row) => {
            if (err) return res.json({ success: false, message: "DB 조회 오류" });
            if (!row) return res.json({ success: false, message: "오늘 배정된 근무지가 없습니다." });

            const dist = getDistance(lat, lng, row.latitude, row.longitude);
            if (dist > 50) return res.json({ success: false, message: `현장 반경 50을 벗어났습니다. (현재: ${Math.round(dist)})` });

            // 출근 시간 10분 전 체크
            const [cHour, cMin] = currentTime.split(':').map(Number);
            const [sHour, sMin] = row.start_time.split(':').map(Number);
            if ((cHour * 60 + cMin) < (sHour * 60 + sMin - 10)) {
                return res.json({ success: false, message: "아직 출근 시간 전입니다." });
            }

            const status = currentTime > row.start_time ? '지각' : '정상';
            db.run(`INSERT INTO attendance_logs (employee_id, site_id, work_date, check_in_time, status) VALUES (?, ?, ?, ?, ?)`,
                [employee_id, row.site_id, work_date, now.toISOString(), status], (err) => {
                    res.json({ success: true, message: `출근 등록 완료 (${status})` });
                });
        });
    } else {
        // 퇴근: 날짜와 상관없이 가장 최근의 '퇴근하지 않은' 기록 조회
        const query = `
            SELECT al.id, al.work_date, s.latitude, s.longitude 
            FROM attendance_logs al
            JOIN sites s ON al.site_id = s.id
            WHERE al.employee_id = ? AND al.check_out_time IS NULL
            ORDER BY al.id DESC LIMIT 1`;

        db.get(query, [employee_id], (err, row) => {
            if (err) return res.json({ success: false, message: "DB 조회 오류" });
            if (!row) return res.json({ success: false, message: "진행 중인 근무(출근 기록)를 찾을 수 없습니다." });

            const dist = getDistance(lat, lng, row.latitude, row.longitude);
            if (dist > 50) return res.json({ success: false, message: `현장 반경 50을 벗어났습니다. (현재: ${Math.round(dist)})` });

            // 퇴근 시간 30분 초과 체크 및 연장 근로 확인
            const schedQuery = `
                SELECT es.type, IFNULL(es.extra_end, wp.end_time) as end_time
                FROM employee_schedules es
                JOIN work_patterns wp ON es.pattern_id = wp.id
                WHERE es.employee_id = ? AND ? BETWEEN es.start_date AND IFNULL(es.end_date, '9999-12-31') AND es.status = 'approved'
            `;
            db.all(schedQuery, [employee_id, row.work_date], (err, schedules) => {
                const normalSchedules = schedules.filter(s => s.type === 'normal');
                const hasExtra = schedules.some(s => s.type === 'extra');

                if (normalSchedules.length > 0 && !hasExtra) {
                    const maxEnd = normalSchedules.reduce((max, s) => s.end_time > max ? s.end_time : max, "00:00");
                    
                    // 위에서 계산한 한국 시간(currentTime)을 기준으로 분 단위 환산
                    const [cHour, cMin] = currentTime.split(':').map(Number);
                    const currentTotal = cHour * 60 + cMin;
                    const [eHour, eMin] = maxEnd.split(':').map(Number);
                    const endTotal = eHour * 60 + eMin;
                    if (currentTotal > endTotal + 30) {
                        return res.json({ success: false, message: "연장 근로가 등록되지 않았습니다. 연장 근로일 경우 별도 신청을 해주세요." });
                    }
                }
                db.run(`UPDATE attendance_logs SET check_out_time = ? WHERE id = ?`,
                    [now.toISOString(), row.id], (err) => {
                        res.json({ success: true, message: "퇴근 등록 완료" });
                    });
            });
        });
    }
});

// [사용자] 내 스케줄 조회
app.get('/api/user/schedule', isAuthenticated, (req, res) => {
    db.all(`SELECT es.*, wp.pattern_name, wp.start_time, wp.end_time, s.name as site_name 
            FROM employee_schedules es 
            JOIN work_patterns wp ON es.pattern_id = wp.id
            JOIN sites s ON wp.site_id = s.id
            WHERE es.employee_id = ? AND es.status = 'approved'`, [req.session.user.id], (err, rows) => res.json(rows));
});

// 존재하지 않는 경로 접속 시 루트로 리다이렉트 (Cannot GET 방지)
app.use((req, res) => {
    res.redirect('/');
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));
