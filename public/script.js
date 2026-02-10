// ============================
// グローバル変数
// ============================
let socket = null, myPeer = null, myStream = null;
let users = {}, peers = {};
let myId = null;
let myX = 100, myY = 300;
let myName = "ゲスト";
let myRoomId = null; 
let isMicMutedByUser = true;
let audioContext = null; // 音声テスト用

const WORLD_W = 2000;
const WORLD_H = 1500;
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

// 会議室データ
const MEETING_ROOMS = [
    { id: 'A', name: '会議室A', type: 'rect', x: 1200, y: 100, w: 300, h: 300, capacity: 2 },
    { id: 'B', name: '会議室B', type: 'circle', x: 1400, y: 600, r: 180, capacity: 4 }
];

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const micBtn = document.getElementById('micBtn');

// ============================
// 初期化 & 音声テスト
// ============================
window.addEventListener('load', async () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    if (isMobile) document.getElementById('d-pad').style.display = 'block';

    // マイク・スピーカー一覧取得
    await getDevices('micSelect', 'speakerSelect');
    
    // マイク選択変更時にテスト用ビジュアライザーを起動
    document.getElementById('micSelect').addEventListener('change', startMicTest);
    startMicTest(); // 初期起動

    document.getElementById('startBtn').addEventListener('click', initGame);
});

// スピーカーテスト音再生
function testSpeaker() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    // スピーカー指定 (Chrome等のみ)
    const spkId = document.getElementById('speakerSelect').value;
    if (spkId && ctx.setSinkId) ctx.setSinkId(spkId);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 440; // ラの音
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + 0.5);
    osc.stop(ctx.currentTime + 0.5);
}

// マイクテスト (緑のバーを動かす)
function startMicTest() {
    const micId = document.getElementById('micSelect').value;
    if(!micId) return;

    navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: micId } } })
    .then(stream => {
        // 既存のコンテキストがあれば閉じる
        if(audioContext) audioContext.close();
        
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const src = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const bar = document.getElementById('mic-visualizer-bar');

        const update = () => {
            if(document.getElementById('entry-modal').style.display === 'none') return; // 入室したら停止
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for(let i=0; i<dataArray.length; i++) sum += dataArray[i];
            const avg = sum / dataArray.length;
            bar.style.width = Math.min(100, avg * 2) + '%'; // 音量に応じて幅変更
            requestAnimationFrame(update);
        };
        update();
    })
    .catch(e => console.log("マイクテスト待機中..."));
}

// ============================
// ゲーム開始
// ============================
function initGame() {
    const nameInput = document.getElementById('username');
    if (!nameInput.value) { alert("名前を入力してください"); return; }
    myName = nameInput.value;

    document.getElementById('entry-modal').style.display = 'none';
    
    // 本番用マイク取得
    const micId = document.getElementById('micSelect').value;
    navigator.mediaDevices.getUserMedia({ audio: { deviceId: micId ? { exact: micId } : undefined } })
    .then(stream => {
        myStream = stream;
        setMicState(false); // 初期はミュート
        startConnection();
    })
    .catch(err => {
        alert("マイクエラー: " + err);
    });
}

function startConnection() {
    socket = io();
    socket.on('connect', () => { myId = socket.id; });

    socket.on('updateUsers', (data) => {
        users = data;
        connectToUsers(); // ユーザー情報更新時に接続チェック
    });

    myPeer = new Peer();
    myPeer.on('open', id => socket.emit('enterRoom', { name: myName, peerId: id }));
    myPeer.on('call', call => { call.answer(myStream); handleStream(call); });

    loop();
}

function loop() {
    draw();
    requestAnimationFrame(loop);
}

// ============================
// 退出処理
// ============================
function exitOffice() {
    if(confirm("退出して最初の画面に戻りますか？")) {
        location.reload(); // ページをリロードして完全リセット
    }
}

// ============================
// 会議室 & 音声ロジック (修正版)
// ============================

// クリック判定
canvas.addEventListener('click', (e) => {
    if (myRoomId) return; // 会議室にいるなら移動不可

    const pos = getWorldPos(e.clientX, e.clientY);
    
    // 会議室判定
    const clickedRoom = MEETING_ROOMS.find(r => {
        if (r.type === 'rect') return pos.x >= r.x && pos.x <= r.x + r.w && pos.y >= r.y && pos.y <= r.y + r.h;
        else return Math.sqrt((pos.x - r.x)**2 + (pos.y - r.y)**2) <= r.r;
    });

    if (clickedRoom) showRoomModal(clickedRoom);
    else moveMe(pos.x, pos.y);
});

// 会議室入室
function showRoomModal(room) {
    const count = Object.values(users).filter(u => u.roomId === room.id).length;
    if (count >= room.capacity) { alert("満員です"); return; }
    
    document.getElementById('room-title').innerText = room.name;
    document.getElementById('room-info').innerText = `定員: ${count}/${room.capacity}`;
    document.getElementById('room-modal').style.display = 'flex';
    
    document.getElementById('joinRoomBtn').onclick = () => {
        myRoomId = room.id;
        
        // サーバーへ「部屋に入ったこと」を通知するため座標と一緒にroomIdを送る
        let targetX = (room.type === 'rect') ? room.x + room.w/2 : room.x;
        let targetY = (room.type === 'rect') ? room.y + room.h/2 : room.y;
        myX = targetX; myY = targetY;
        
        socket.emit('move', { x: myX, y: myY, roomId: myRoomId }); // ★ここが重要
        
        document.getElementById('room-modal').style.display = 'none';
        document.getElementById('leaveRoomBtn').style.display = 'block';
        document.getElementById('room-status').style.display = 'block';
        
        checkAudioStatus();
    };
}

function closeRoomModal() { document.getElementById('room-modal').style.display = 'none'; }

// 会議室退室
function leaveMeetingRoom() {
    myRoomId = null;
    moveMe(myX, myY + 150); // 少し外へ移動
    document.getElementById('leaveRoomBtn').style.display = 'none';
    document.getElementById('room-status').style.display = 'none';
    checkAudioStatus();
}

function moveMe(x, y) {
    if (!socket) return;
    myX = Math.max(20, Math.min(x, WORLD_W-20));
    myY = Math.max(20, Math.min(y, WORLD_H-20));
    socket.emit('move', { x: myX, y: myY, roomId: myRoomId });
    checkAudioStatus();
}

// ----------------------
// 音声接続制御 (最重要修正)
// ----------------------
function checkAudioStatus() {
    let canSpeak = false;

    if (myRoomId) {
        // 会議室
        canSpeak = true;
        micBtn.innerText = isMicMutedByUser ? "マイクOFF" : "マイクON (会議中)";
        micBtn.disabled = false;
        micBtn.style.background = isMicMutedByUser ? "#e74c3c" : "#e67e22"; // オレンジ
    } else if (myX < 600) {
        // 作業エリア
        canSpeak = false;
        micBtn.innerText = "会話禁止エリア";
        micBtn.disabled = true;
        micBtn.style.background = "#555";
    } else {
        // リビング
        canSpeak = true;
        micBtn.innerText = isMicMutedByUser ? "マイクOFF" : "マイクON";
        micBtn.disabled = false;
        micBtn.style.background = isMicMutedByUser ? "#e74c3c" : "#27ae60"; // 赤/緑
    }

    setMicState(canSpeak && !isMicMutedByUser);
    connectToUsers();
}

function connectToUsers() {
    if (!myPeer || !myStream) return;

    Object.keys(users).forEach(id => {
        if (id === myId) return;
        const u = users[id];
        let shouldConnect = false;

        if (myRoomId) {
            // ★自分が会議室にいる場合：相手も「同じIDの会議室」にいるか？
            if (u.roomId === myRoomId) shouldConnect = true;
        } else {
            // ★自分が通常エリア：相手も「部屋なし」かつ「リビング(X>=600)」か？
            if (!u.roomId && myX >= 600 && u.x >= 600) shouldConnect = true;
        }

        if (shouldConnect) {
            if (!peers[id]) {
                const call = myPeer.call(u.peerId, myStream);
                peers[id] = call;
                handleStream(call);
            }
        } else {
            // 切断処理
            if (peers[id]) {
                peers[id].close();
                delete peers[id];
                const el = document.getElementById(id);
                if(el) el.remove();
            }
        }
    });
}

function handleStream(call) {
    call.on('stream', userAudio => {
        if (document.getElementById(call.peer)) return;
        const audio = document.createElement('audio');
        audio.id = call.peer;
        audio.srcObject = userAudio;
        audio.autoplay = true; audio.playsInline = true;
        const spkId = document.getElementById('speakerSelectInGame').value;
        if(spkId && audio.setSinkId) audio.setSinkId(spkId);
        document.body.appendChild(audio);
    });
}

// ============================
// その他 (描画・設定など)
// ============================
function toggleMic() {
    isMicMutedByUser = !isMicMutedByUser;
    checkAudioStatus();
}

function setMicState(isOn) {
    if (myStream && myStream.getAudioTracks()[0]) {
        myStream.getAudioTracks()[0].enabled = isOn;
    }
}

function draw() {
    let camX = myX - canvas.width / 2;
    let camY = myY - canvas.height / 2;
    camX = Math.max(0, Math.min(camX, WORLD_W - canvas.width));
    camY = Math.max(0, Math.min(camY, WORLD_H - canvas.height));

    ctx.save();
    ctx.translate(-camX, -camY);

    // 背景
    ctx.fillStyle = "#f4f1ea"; ctx.fillRect(0, 0, WORLD_W, WORLD_H);
    
    // エリア
    ctx.fillStyle = "#e8ecef"; ctx.fillRect(0, 0, 600, WORLD_H); // 作業
    ctx.fillStyle = "#bdc3c7"; // 机
    for(let i=0; i<5; i++) for(let j=0; j<3; j++) ctx.fillRect(100 + j*150, 200 + i*200, 100, 60);

    // 会議室描画
    MEETING_ROOMS.forEach(r => {
        ctx.fillStyle = "rgba(255,255,255,0.8)"; ctx.strokeStyle = "#34495e"; ctx.lineWidth = 5;
        if(r.type==='rect') { ctx.fillRect(r.x, r.y, r.w, r.h); ctx.strokeRect(r.x, r.y, r.w, r.h); }
        else { ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, Math.PI*2); ctx.fill(); ctx.stroke(); }
        
        ctx.fillStyle = "#2c3e50"; ctx.font = "bold 20px sans-serif";
        ctx.fillText(r.name, r.type==='rect'?r.x+20:r.x-60, r.type==='rect'?r.y+40:r.y);
    });

    // ユーザー
    Object.keys(users).forEach(id => {
        const u = users[id];
        ctx.fillStyle = (id === myId) ? '#e74c3c' : '#3498db';
        ctx.beginPath(); ctx.arc(u.x, u.y, 20, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#333"; ctx.font = "bold 14px sans-serif"; ctx.textAlign = "center";
        ctx.fillText(u.name, u.x, u.y - 30);
        if(u.roomId) ctx.fillText("🔒", u.x, u.y - 45);
    });

    ctx.restore();
}

function getWorldPos(cx, cy) {
    let camX = myX - canvas.width / 2;
    let camY = myY - canvas.height / 2;
    camX = Math.max(0, Math.min(camX, WORLD_W - canvas.width));
    camY = Math.max(0, Math.min(camY, WORLD_H - canvas.height));
    return { x: cx + camX, y: cy + camY };
}

async function getDevices(mId, sId) {
    try {
        const d = await navigator.mediaDevices.enumerateDevices();
        const m = document.getElementById(mId), s = document.getElementById(sId);
        m.innerHTML = ''; s.innerHTML = '';
        d.forEach(v => {
            const o = document.createElement('option'); o.value = v.deviceId; o.text = v.label || v.kind;
            if(v.kind==='audioinput') m.appendChild(o);
            if(v.kind==='audiooutput') s.appendChild(o);
        });
    } catch(e) {}
}

function openSettings() { 
    getDevices('micSelectInGame', 'speakerSelectInGame');
    document.getElementById('settings-modal').style.display = 'flex'; 
}
function closeSettings() { document.getElementById('settings-modal').style.display = 'none'; }

// スマホ移動
const spd = 10;
const setupBtn = (id, dx, dy) => {
    const b = document.getElementById(id);
    let i;
    b.addEventListener('touchstart', (e)=>{ e.preventDefault(); i=setInterval(()=>{if(!myRoomId)moveMe(myX+dx,myY+dy)},50); });
    b.addEventListener('touchend', ()=>clearInterval(i));
};
setupBtn('d-up',0,-spd); setupBtn('d-down',0,spd); setupBtn('d-left',-spd,0); setupBtn('d-right',spd,0);