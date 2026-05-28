const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./attendance.db');

db.serialize(() => {
    // 현장 설정 테이블
    db.run(`CREATE TABLE IF NOT EXISTS sites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        address TEXT,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL
    )`);

    // 근무 패턴 테이블
    db.run(`CREATE TABLE IF NOT EXISTS work_patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id INTEGER,
        pattern_name TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        rest_time INTEGER DEFAULT 0,
        FOREIGN KEY(site_id) REFERENCES sites(id)
    )`);

    // 직원 정보 테이블
    db.run(`CREATE TABLE IF NOT EXISTS employees (
        id INTEGER PRIMARY KEY, -- 사원번호
        password TEXT,
        name TEXT,
        username TEXT UNIQUE, -- 로그인에 사용될 아이디 (문자열)
        department TEXT,
        position TEXT,
        site_id INTEGER, -- 현장관리자의 경우 관리할 현장 ID
        role TEXT DEFAULT 'user', -- 'super_admin', 'site_admin', 'user'
        FOREIGN KEY(site_id) REFERENCES sites(id)
    )`);

    // 근무 배정 테이블
    db.run(`CREATE TABLE IF NOT EXISTS employee_schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER,
        pattern_id INTEGER,
        start_date TEXT NOT NULL,
        end_date TEXT,
        type TEXT DEFAULT 'normal', -- 'normal', 'extra', 'substitute'
        status TEXT DEFAULT 'approved', -- 'pending', 'approved', 'rejected'
        extra_start TEXT,
        extra_end TEXT,
        FOREIGN KEY(employee_id) REFERENCES employees(id),
        FOREIGN KEY(pattern_id) REFERENCES work_patterns(id)
    )`);

    // 출퇴근 로그 테이블
    db.run(`CREATE TABLE IF NOT EXISTS attendance_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER,
        site_id INTEGER,
        work_date TEXT,
        check_in_time DATETIME,
        check_out_time DATETIME,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT
    )`);

    // 마이그레이션: 컬럼 존재 여부 확인 없이 시도하되 에러 무시 (실제 운영 시에는 PRAGMA table_info 사용 권장)
    const columns = [
        "ALTER TABLE employees ADD COLUMN site_id INTEGER",
        "ALTER TABLE employees ADD COLUMN role TEXT DEFAULT 'user'",
        "ALTER TABLE employee_schedules ADD COLUMN type TEXT DEFAULT 'normal'",
        "ALTER TABLE employee_schedules ADD COLUMN status TEXT DEFAULT 'approved'",
        "ALTER TABLE employee_schedules ADD COLUMN extra_start TEXT",
        "ALTER TABLE employee_schedules ADD COLUMN extra_end TEXT",
        "ALTER TABLE work_patterns ADD COLUMN rest_time INTEGER DEFAULT 0"
    ];
    columns.forEach(sql => db.run(sql, (err) => { /* 컬럼 이미 존재 시 에러 무시 */ }));

    // 테스트용 데이터 삽입
    db.run("INSERT OR IGNORE INTO sites (id, name, latitude, longitude) VALUES (1, '서울본사', 37.5665, 126.9780)");
    db.run("INSERT OR IGNORE INTO work_patterns (id, site_id, pattern_name, start_time, end_time) VALUES (1, 1, '주간조', '09:00', '18:00')");
    
    // 주의: 테스트 중 데이터 유지를 위해 DELETE 문은 삭제하거나 주석 처리합니다.

    // 최고관리자 정보 삽입: 아이디 'superadmin', 비밀번호 '1234'
    db.run("INSERT OR IGNORE INTO employees (id, username, password, name, role) VALUES (1, 'superadmin', '1234', '최고관리자', 'super_admin')");
});

module.exports = db;
