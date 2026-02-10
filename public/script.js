// ============================
// 設定・グローバル変数
// ============================
let socket = null, myPeer = null, myStream = null;
let users = {}, peers = {};
let myId = null;
let myX = 100, myY = 300;
let myName = "ゲスト";
let myRoomId = null; // null=通常エリア, 'A'=会議室A...
let isMicMutedByUser = true;
let isDragging = false;

// ワールド設定
const WORLD_W = 2000;
const WORLD_H = 1500;
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

// 会議室データ
const MEETING_ROOMS = [
    { id: 'A', name: '会議室A (四角)', type: 'rect', x: 1200, y: 100, w: 300, h: 300, capacity: 2 },
    { id: 'B', name: '会議室B (丸)', type: 'circle', x: 1400, y: 600, r: 180, capacity: 4 }
];

// エリア定義（音響用）
const ZONES = {
    WORK: { x: 0, w: 600, name: "集中エリア" },
    LIVING: { x: 600, w: 1400, name: "リビング" }
};

// DOM要素
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const micLabel = document.getElementById('micLabel');
const micDot = document.getElementById('mic-dot');
const statusText = document.getElementById('status-text');

// 初期化
window.addEventListener('load', async () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    if (isMobile) document.getElementById('d-pad').style.display = 'block';
    await getDevices('micSelect', 'speakerSelect');
    document.getElementById('startBtn').addEventListener('click', initGame);
});

window.addEventListener('resize', () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    draw();
});

// ============================
// ゲーム開始 & 接続
// ============================
function initGame() {
    const nameInput = document.getElementById('username');
    if (!nameInput.value) { alert("名前を入力してください"); return; }
    myName = nameInput.value;

    document.getElementById('entry-modal').style.display = 'none';
    unlockAudioContext(); // スマホ用音声対策

    const micId = document.getElementById('micSelect').value;
    navigator.mediaDevices.getUserMedia({ audio: { deviceId: micId ? { exact: micId } : undefined } })
    .then(stream => {
        myStream = stream;
        setMicState(false);
        startConnection();
    })
    .catch(err => {
        alert("マイクエラー: " + err);
    });
}

function startConnection() {
    socket = io();
    socket.on('connect', () => {
        myId = socket.id;
        statusText.innerText = "オンライン";
    });

    socket.on('updateUsers', (data) => {
        users = data;
        draw();
        connectToUsers(); // 音声接続管理
    });

    myPeer = new Peer();
    myPeer.on('open', id => socket.emit('enterRoom', { name: myName, peerId: id }));
    myPeer.on('call', call => { call.answer(myStream); handleStream(call); });

    // ループ描画開始（スムーズな移動のため）
    loop();
}

// アニメーションループ
function loop() {
    requestAnimationFrame(loop);
    draw();
}

// ============================
// 描画システム (オフィスデザイン)
// ============================
function draw() {
    // カメラ追従計算 (常に自分が中心)
    let camX = myX - canvas.width / 2;
    let camY = myY - canvas.height / 2;
    // ワールド端の制限
    camX = Math.max(0, Math.min(camX, WORLD_W - canvas.width));
    camY = Math.max(0, Math.min(camY, WORLD_H - canvas.height));

    ctx.save();
    ctx.translate(-camX, -camY);

    // 1. 床を描画
    // 全体（フローリング風）
    ctx.fillStyle = "#f4f1ea"; 
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);
    drawGrid(100, "rgba(0,0,0,0.05)");

    // 2. エリアごとの装飾
    // --- 集中エリア (左側) ---
    ctx.fillStyle = "#e8ecef"; // カーペット
    ctx.fillRect(0, 0, 600, WORLD_H);
    ctx.fillStyle = "#95a5a6"; ctx.font = "bold 40px sans-serif";
    ctx.fillText("WORK AREA (Silence)", 50, 80);
    // デスクを描く
    ctx.fillStyle = "#bdc3c7";
    for(let i=0; i<5; i++) {
        for(let j=0; j<3; j++) ctx.fillRect(100 + j*150, 200 + i*200, 100, 60);
    }

    // --- リビング (右側) ---
    ctx.fillStyle = "#27ae60"; ctx.font = "bold 40px sans-serif";
    ctx.fillText("LIVING AREA", 700, 80);
    // 観葉植物的な緑の丸
    ctx.fillStyle = "#2ecc71";
    ctx.beginPath(); ctx.arc(1900, 100, 50, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(700, 1400, 60, 0, Math.PI*2); ctx.fill();

    // 3. 会議室を描画
    MEETING_ROOMS.forEach(room => {
        ctx.lineWidth = 5;
        ctx.strokeStyle = "#34495e";
        ctx.fillStyle = "rgba(255, 255, 255, 0.7)";

        if (room.type === 'rect') {
            ctx.fillRect(room.x, room.y, room.w, room.h);
            ctx.strokeRect(room.x, room.y, room.w, room.h);
            // 文字
            ctx.fillStyle = "#2c3e50"; ctx.font = "bold 20px sans-serif";
            ctx.fillText(room.name, room.x + 20, room.y + 40);
        } else if (room.type === 'circle') {
            ctx.beginPath();
            ctx.arc(room.x, room.y, room.r, 0, Math.PI*2);
            ctx.fill(); ctx.stroke();
            // 文字
            ctx.fillStyle = "#2c3e50"; ctx.font = "bold 20px sans-serif";
            ctx.fillText(room.name, room.x - 60, room.y);
        }
        
        // 人数表示
        const count = Object.values(users).filter(u => u.roomId === room.id).length;
        ctx.font = "16px sans-serif";
        ctx.fillText(`現在: ${count} / ${room.capacity}名`, room.type==='rect'?room.x+20:room.x-40, room.type==='rect'?room.y+70:room.y+30);
    });

    // 4. ユーザー描画
    Object.keys(users).forEach(id => {
        const u = users[id];
        ctx.fillStyle = (id === myId) ? '#e74c3c' : '#3498db';
        ctx.beginPath(); ctx.arc(u.x, u.y, 20, 0, Math.PI * 2); ctx.fill();
        
        // 名前
        ctx.fillStyle = "#333"; ctx.font = "bold 14px sans-serif"; ctx.textAlign = "center";
        ctx.fillText(u.name, u.x, u.y - 30);
        
        // 会議室にいる場合アイコンを表示
        if(u.roomId) ctx.fillText("🔒", u.x + 15, u.y - 15);
    });

    ctx.restore();
}

function drawGrid(step, color) {
    ctx.beginPath();
    for (let x=0; x<=WORLD_W; x+=step) { ctx.moveTo(x, 0); ctx.lineTo(x, WORLD_H); }
    for (let y=0; y<=WORLD_H; y+=step) { ctx.moveTo(0, y); ctx.lineTo(WORLD_W, y); }
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke();
}

// ============================
// 移動 & 会議室ロジック
// ============================
// クリックで移動 or 会議室入室
canvas.addEventListener('click', (e) => {
    // 既に会議室にいるならクリック移動無効
    if (myRoomId) return;

    const pos = getWorldPos(e.clientX, e.clientY);
    
    // 会議室をクリックしたか判定
    const clickedRoom = MEETING_ROOMS.find(r => {
        if (r.type === 'rect') {
            return pos.x >= r.x && pos.x <= r.x + r.w && pos.y >= r.y && pos.y <= r.y + r.h;
        } else {
            return Math.sqrt((pos.x - r.x)**2 + (pos.y - r.y)**2) <= r.r;
        }
    });

    if (clickedRoom) {
        showRoomModal(clickedRoom);
    } else {
        // 通常移動
        moveMe(pos.x, pos.y);
    }
});

// 会議室入室処理
let selectedRoom = null;
function showRoomModal(room) {
    const count = Object.values(users).filter(u => u.roomId === room.id).length;
    if (count >= room.capacity) {
        alert("満員です！入れません。");
        return;
    }
    selectedRoom = room;
    document.getElementById('room-title').innerText = room.name;
    document.getElementById('room-info').innerText = `定員: ${count} / ${room.capacity}名`;
    document.getElementById('room-modal').style.display = 'flex';
}

document.getElementById('joinRoomBtn').addEventListener('click', () => {
    if (selectedRoom) {
        myRoomId = selectedRoom.id;
        // 部屋の中央へワープ
        if(selectedRoom.type==='rect') moveMe(selectedRoom.x + selectedRoom.w/2, selectedRoom.y + selectedRoom.h/2);
        else moveMe(selectedRoom.x, selectedRoom.y);
        
        document.getElementById('room-modal').style.display = 'none';
        document.getElementById('leaveRoomBtn').style.display = 'flex';
        checkAudioStatus(); // 音声ルール更新
    }
});

function closeRoomModal() { document.getElementById('room-modal').style.display = 'none'; }

// 退室処理
function leaveMeetingRoom() {
    myRoomId = null;
    // 部屋の外へ少し移動
    moveMe(myX, myY + 150);
    document.getElementById('leaveRoomBtn').style.display = 'none';
    checkAudioStatus();
}

function moveMe(x, y) {
    if (!socket) return;
    myX = Math.max(20, Math.min(x, WORLD_W-20));
    myY = Math.max(20, Math.min(y, WORLD_H-20));
    
    socket.emit('move', { x: myX, y: myY, roomId: myRoomId });
    checkAudioStatus();
}

// 座標変換
function getWorldPos(cx, cy) {
    let camX = myX - canvas.width / 2;
    let camY = myY - canvas.height / 2;
    camX = Math.max(0, Math.min(camX, WORLD_W - canvas.width));
    camY = Math.max(0, Math.min(camY, WORLD_H - canvas.height));
    return { x: cx + camX, y: cy + camY };
}

// ============================
// 音声制御ロジック (最重要)
// ============================
function checkAudioStatus() {
    // 1. 作業エリア(X<600) なら強制ミュート
    // 2. 会議室にいるなら、同じ会議室の人とだけ
    // 3. リビング(X>=600) で会議室でないなら、リビングの人とだけ
    
    let canSpeak = false;

    if (myRoomId) {
        // 会議室の中
        canSpeak = true;
        micLabel.innerText = isMicMutedByUser ? "OFF" : "会議中";
    } else if (myX < 600) {
        // 作業エリア
        canSpeak = false;
        micLabel.innerText = "禁止";
    } else {
        // リビング
        canSpeak = true;
        micLabel.innerText = isMicMutedByUser ? "OFF" : "ON";
    }

    // 物理的なマイクON/OFF
    setMicState(canSpeak && !isMicMutedByUser);
    micDot.className = (canSpeak && !isMicMutedByUser) ? "dot active" : "dot";

    connectToUsers(); // 接続相手を更新
}

function connectToUsers() {
    if (!myPeer || !myStream) return;

    Object.keys(users).forEach(id => {
        if (id === myId) return;
        const u = users[id];
        
        // 接続すべきか判定
        let shouldConnect = false;

        if (myRoomId) {
            // 自分が会議室: 同じ部屋の人とだけ
            if (u.roomId === myRoomId) shouldConnect = true;
        } else {
            // 自分が通常エリア
            if (!u.roomId && myX >= 600 && u.x >= 600) {
                // 相手も通常エリア かつ お互いリビングにいる
                shouldConnect = true;
            }
        }

        // 接続実行 または 切断
        if (shouldConnect) {
            if (!peers[id]) {
                const call = myPeer.call(u.peerId, myStream);
                peers[id] = call;
                handleStream(call);
            }
        } else {
            // 接続すべきでないのに繋がっていたら切る
            if (peers[id]) {
                peers[id].close();
                delete peers[id];
                const el = document.getElementById(id); // 音声タグ削除
                if(el) el.remove();
            }
        }
    });
}

function handleStream(call) {
    call.on('stream', userAudio => {
        if (document.getElementById(call.peer)) return;
        const audio = document.createElement('audio');
        audio.id = call.peer; // ユーザーIDではなくPeerIDで管理される点に注意
        audio.srcObject = userAudio;
        audio.playsInline = true; audio.autoplay = true;
        
        // スピーカー適用
        const spkId = document.getElementById('speakerSelectInGame').value;
        if(spkId && audio.setSinkId) audio.setSinkId(spkId);

        document.body.appendChild(audio);
    });
}

// ============================
// デバイス & 設定系
// ============================
async function getDevices(micId, spkId) {
    try {
        const dev = await navigator.mediaDevices.enumerateDevices();
        const m = document.getElementById(micId);
        const s = document.getElementById(spkId);
        m.innerHTML = ''; s.innerHTML = '';
        dev.forEach(d => {
            const o = document.createElement('option');
            o.value = d.deviceId; o.text = d.label || d.kind;
            if(d.kind==='audioinput') m.appendChild(o);
            if(d.kind==='audiooutput') s.appendChild(o);
        });
    } catch(e) { console.error(e); }
}

function toggleMic() {
    isMicMutedByUser = !isMicMutedByUser;
    checkAudioStatus();
}

function setMicState(isOn) {
    if (myStream && myStream.getAudioTracks()[0]) {
        myStream.getAudioTracks()[0].enabled = isOn;
    }
}

function unlockAudioContext() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) { const c = new AC(); c.resume(); }
}

// 設定モーダル
function openSettings() {
    getDevices('micSelectInGame', 'speakerSelectInGame');
    document.getElementById('settings-modal').style.display = 'flex';
}
function closeSettings() {
    document.getElementById('settings-modal').style.display = 'none';
}

// 十字キー (スマホ移動)
const speed = 10;
const setupBtn = (id, dx, dy) => {
    const btn = document.getElementById(id);
    let interval;
    const action = () => {
        if (myRoomId) return; // 部屋の中では移動不可にするか、部屋内のみにするか（今回は不可に設定）
        moveMe(myX + dx, myY + dy);
    };
    btn.addEventListener('touchstart', (e)=>{ e.preventDefault(); interval=setInterval(action,50); });
    btn.addEventListener('touchend', ()=>clearInterval(interval));
};
setupBtn('d-up',0,-speed); setupBtn('d-down',0,speed); setupBtn('d-left',-speed,0); setupBtn('d-right',speed,0);