// 글로벌 상태 변수
let currentUser = null;

// 초기화
document.addEventListener('DOMContentLoaded', async () => {
    updateClock();
    setInterval(updateClock, 1000);
    await checkSession();
    displayMyDeviceInfo();
});

// 1. 24시간제 시계 업데이트
function updateClock() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    
    const liveClock = document.getElementById('liveClock');
    if (liveClock) {
        liveClock.innerText = `${hours}:${minutes}:${seconds}`;
    }

    const liveDate = document.getElementById('liveDate');
    if (liveDate) {
        const days = ['일', '월', '화', '수', '목', '금', '토'];
        liveDate.innerText = `${now.getFullYear()}년 ${String(now.getMonth() + 1).padStart(2, '0')}월 ${String(now.getDate()).padStart(2, '0')}일 (${days[now.getDay()]})`;
    }
}

// 2. 세션 체크
async function checkSession() {
    try {
        const res = await fetch('/api/me');
        if (!res.ok) {
            window.location.href = '/login.html';
            return;
        }
        currentUser = await res.json();
        document.getElementById('navUserName').innerText = `${currentUser.name} (${currentUser.role})`;

        if (currentUser.role === 'super_admin' || currentUser.role === 'site_admin') {
            document.getElementById('adminTab').classList.remove('d-none');
            loadMacRequests();
        }
    } catch (e) {
        window.location.href = '/login.html';
    }
}

// SPA 페이지 전환
function switchPage(pageName) {
    document.querySelectorAll('.page-section').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('#mainTab .nav-link').forEach(el => el.classList.remove('active'));

    const target = document.getElementById(`view-${pageName}`);
    if (target) target.classList.remove('hidden');

    if (pageName === 'record-sheet') {
        loadRecordSheet();
    }
}

// 3. 기기 식별자(MAC) 가져오기 및 표시
function getDeviceId() {
    return localStorage.getItem('app_device_mac') || 'UNKNOWN';
}

function displayMyDeviceInfo() {
    const macSpan = document.getElementById('myDeviceMac');
    if (macSpan) macSpan.innerText = getDeviceId();
    
    if (currentUser) {
        const statusSpan = document.getElementById('myMacStatus');
        if (currentUser.mac_status === 'APPROVED') {
            statusSpan.className = 'badge badge-success';
            statusSpan.innerText = '승인됨';
        } else if (currentUser.mac_status === 'PENDING') {
            statusSpan.className = 'badge badge-warning';
            statusSpan.innerText = '승인 대기중';
        } else {
            statusSpan.className = 'badge badge-secondary';
            statusSpan.innerText = '미등록/거절';
        }
    }
}

// MAC 변경 신청
async function requestMacChange() {
    const deviceMac = getDeviceId();
    const res = await fetch('/api/mac/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceMac })
    });
    const data = await res.json();
    alert(data.message || data.error);
    checkSession();
}

// 4. 출/퇴근 등록
async function handleAttendance(type) {
    const msgDiv = document.getElementById('attendanceMsg');
    msgDiv.innerText = '위치 확인 및 처리 중...';
    msgDiv.className = 'mt-2 text-center small font-weight-bold text-info';

    if (!navigator.geolocation) {
        alert('GPS를 지원하지 않는 브라우저입니다.');
        return;
    }

    navigator.geolocation.getCurrentPosition(async (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const deviceMac = getDeviceId();

        try {
            const res = await fetch('/api/attendance', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type, lat, lng, deviceMac })
            });

            const data = await res.json();
            if (res.ok) {
                msgDiv.className = 'mt-2 text-center small font-weight-bold text-success';
                msgDiv.innerText = data.message;
            } else {
                msgDiv.className = 'mt-2 text-center small font-weight-bold text-danger';
                msgDiv.innerText = data.error;
            }
        } catch (e) {
            msgDiv.className = 'mt-2 text-center small font-weight-bold text-danger';
            msgDiv.innerText = '서버 통신 중 오류가 발생했습니다.';
        }
    }, (err) => {
        msgDiv.className = 'mt-2 text-center small font-weight-bold text-danger';
        msgDiv.innerText = 'GPS 위치 정보를 가져올 수 없습니다.';
    });
}

// 5. 상황실 근무 상황 기록부 로드 및 테이블 동적 생성
async function loadRecordSheet() {
    const yearMonth = document.getElementById('recordSheetMonth').value; // '2026-07'
    const [year, month] = yearMonth.split('-');
    
    document.getElementById('sheetYearMonth').innerText = `${year}년 ${parseInt(month)}월`;

    const totalDays = new Date(year, month, 0).getDate();
    const daysArr = ['일', '월', '화', '수', '목', '금', '토'];

    // 기존 헤더 일자 셀 제거 후 재생성
    const hRow1 = document.getElementById('headerRow1');
    const hRow2 = document.getElementById('headerRow2');

    // 기존 동적 셀 제거
    document.querySelectorAll('.day-cell-header').forEach(el => el.remove());

    for (let d = 1; d <= totalDays; d++) {
        const dateObj = new Date(year, month - 1, d);
        const dayOfWeek = daysArr[dateObj.getDay()];

        const th1 = document.createElement('th');
        th1.className = 'day-cell-header';
        th1.style.width = '20px';
        th1.innerText = d;
        hRow1.appendChild(th1);

        const th2 = document.createElement('th');
        th2.className = 'day-cell-header';
        th2.style.width = '20px';
        th2.innerText = dayOfWeek;
        hRow2.appendChild(th2);
    }

    // 서버에서 해당 월 스케줄 및 근무자 목록 데이터 가져오기
    try {
        const res = await fetch(`/api/schedule/monthly-report?month=${yearMonth}`);
        const data = await res.json();

        const tbody = document.getElementById('sheetTableBody');
        tbody.innerHTML = '';

        if (!data.users || data.users.length === 0) {
            tbody.innerHTML = `<tr><td colspan="${4 + totalDays}">등록된 근무자 데이터가 없습니다.</td></tr>`;
            return;
        }

        data.users.forEach(user => {
            let tr = document.createElement('tr');
            
            let html = `
                <td>${user.duty_type || '상황실 대원'}</td>
                <td>
                    <div style="font-weight:bold;">${user.name}</div>
                    <div style="font-size: 7pt; color: #555;">${user.birth_date || ''}</div>
                </td>
                <td style="font-size: 7.5pt;">${user.assigned_date || ''}</td>
                <td style="font-size: 7.5pt;">${user.closed_date || ''}</td>
            `;

            for (let d = 1; d <= totalDays; d++) {
                const dayKey = String(d).padStart(2, '0');
                const code = (user.schedules && user.schedules[dayKey]) ? user.schedules[dayKey] : '';
                html += `<td>${code}</td>`;
            }

            tr.innerHTML = html;
            tbody.appendChild(tr);
        });

    } catch (e) {
        console.error(e);
    }
}

// 6. 관리자 - MAC 승인 요청 목록 조회 및 처리
async function loadMacRequests() {
    const res = await fetch('/api/mac/requests');
    const data = await res.json();
    
    const tbody = document.getElementById('macApprovalList');
    tbody.innerHTML = '';

    if (!data || data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">대기 중인 요청이 없습니다.</td></tr>';
        return;
    }

    data.forEach(req => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${req.name}</td>
            <td class="text-muted small">${req.mac_address || '미등록'}</td>
            <td class="text-primary font-weight-bold small">${req.pending_mac}</td>
            <td>
                <button onclick="approveMac(${req.id}, true)" class="btn btn-sm btn-success py-0">승인</button>
                <button onclick="approveMac(${req.id}, false)" class="btn btn-sm btn-danger py-0">거절</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

async function approveMac(userId, approve) {
    const res = await fetch('/api/mac/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, approve })
    });
    const data = await res.json();
    alert(data.message);
    loadMacRequests();
}

async function logout() {
    await fetch('/logout', { method: 'POST' });
    window.location.href = '/login.html';
}
