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
let audioContext = null; 

const WORLD_W = 2000;
const WORLD_H = 1500;
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

const MEETING_ROOMS = [
    { id: 'A', name: '会議室A', type: 'rect', x: 1200, y: 100, w: 300, h: 300, capacity: 2 },
    { id: 'B', name: '会議室B', type: 'circle', x: 1400, y: 600, r: 180, capacity: 4 }
];

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const micBtn = document.getElementById('micBtn');

// ============================
// 1. セットアップ開始 (スマホ対策)
// ============================
window.addEventListener('load', () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    if (isMobile) document.getElementById('d-pad').style.display = 'block';
});

// 「TAP TO START」を押した時に呼ばれる
async function startSetup() {
    // 1. 無音を再生してオーディオコンテキストをアンロック
    unlockAudioContext();

    // 2. マイクの許可を求める（ここで許可しないとリストが出ない）
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // 一旦止める（設定画面で再度取得するため）
        stream.getTracks().forEach(t => t.stop());
        
        // 3. デバイス一覧を取得して設定画面へ
        await getDevices('micSelect', 'speakerSelect');
        
        document.getElementById('start-overlay').style.display = 'none';
        document.getElementById('entry-modal').style.display = 'flex';

        // マイクテスト開始
        document.getElementById('micSelect').addEventListener('change', startMicTest);
        startMicTest();

    } catch (err) {
        alert("マイクの使用を許可してください。設定画面から許可してリロードしてください。");
        console.error(err);
    }
}

// 無音を再生する関数
function unlockAudioContext() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0; // 無音
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(0);
    osc.stop(0.1); // 0.1秒だけ再生
}

// ============================
// 入室前テスト機能
// ============================
function testSpeaker() {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const spkId = document.getElementById('speakerSelect').value;
    
    // スピーカー指定
    if (spkId && ctx.setSinkId) ctx.setSinkId(spkId).catch(e=>{}); // エラー無視
    else if (spkId && HTMLAudioElement.prototype.setSinkId) {
        // Audioタグを使うフォールバック
        const audio = new Audio();
        audio.setSinkId(spkId);
        // ここで音源ファイルを再生する手もあるが今回は簡易発振音で
    }

    osc.connect(ctx.destination);
    osc.frequency.value = 523.25; // ドの音
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
}

function startMicTest() {
    const micId = document.getElementById('micSelect').value;
    if(!micId) return;

    navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: micId } } })
    .then(stream => {
        if(audioContext) audioContext.close();
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const src = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);

        const data = new Uint8Array(analyser.frequencyBinCount);
        const bar = document.getElementById('mic-visualizer-bar');

        const update = () => {
            if(document.getElementById('entry-modal').style.display === 'none') return;
            analyser.getByteFrequencyData(data);
            let sum = 0;
            for(let i=0; i<data.length; i++) sum += data[i];
            const vol = sum / data.length;
            bar.style.width = Math.min(100, vol * 3) + '%';
            requestAnimationFrame(update);
        };
        update();
    })
    .catch(e => console.log(e));
}

// ============================
// ゲーム開始
// ============================
document.getElementById('enterGameBtn').addEventListener('click', () => {
    const nameInput = document.getElementById('username');
    if (!nameInput.value) { alert("名前を入力してください"); return; }
    myName = nameInput.value;

    document.getElementById('entry-modal').style.display = 'none';
    
    // 本番用ストリーム取得
    const micId = document.getElementById('micSelect').value;
    navigator.mediaDevices.getUserMedia({ 
        audio: { 
            deviceId: micId ? { exact: micId } : undefined,
            echoCancellation: true,
            noiseSuppression: true
        } 
    })
    .then(stream => {
        myStream = stream;
        setMicState(false);
        startConnection();
    })
    .catch(err => alert("エラー: " + err));
});

function startConnection() {
    socket = io();
    socket.on('connect', () => { myId = socket.id; });
    socket.on('updateUsers', (data) => {
        users = data;
        connectToUsers(); 
    });

    myPeer = new Peer();
    myPeer.on('open', id => socket.emit('enterRoom', { name: myName, peerId: id }));
    myPeer.on('call', call => { call.answer(myStream); handleStream(call); });

    loop();
}

function loop() { draw(); requestAnimationFrame(loop); }

// ============================
// 会議室ロジック (重なり防止 & 音声修正)
// ============================
canvas.addEventListener('click', (e) => {
    if (myRoomId) return;
    const pos = getWorldPos(e.clientX, e.clientY);
    const room = MEETING_ROOMS.find(r => {
        if (r.type === 'rect') return pos.x >= r.x && pos.x <= r.x+r.w && pos.y >= r.y && pos.y <= r.y+r.h;
        else return Math.sqrt((pos.x-r.x)**2 + (pos.y-r.y)**2) <= r.r;
    });
    if (room) showRoomModal(room);
    else moveMe(pos.x, pos.y);
});

function showRoomModal(room) {
    const count = Object.values(users).filter(u => u.roomId === room.id).length;
    if (count >= room.capacity) { alert("満員です"); return; }
    
    document.getElementById('room-title').innerText = room.name;
    document.getElementById('room-info').innerText = `定員: ${count}/${room.capacity}`;
    document.getElementById('room-modal').style.display = 'flex';
    
    document.getElementById('joinRoomBtn').onclick = () => {
        myRoomId = room.id;
        
        // ★重なり防止: ランダムな位置を計算
        let targetX, targetY;
        if (room.type === 'rect') {
            // 四角の中のランダムな位置 (端っこは避ける)
            targetX = room.x + 20 + Math.random() * (room.w - 40);
            targetY = room.y + 20 + Math.random() * (room.h - 40);
        } else {
            // 丸の中のランダムな位置
            const angle = Math.random() * Math.PI * 2;
            const radius = Math.random() * (room.r - 20);
            targetX = room.x + Math.cos(angle) * radius;
            targetY = room.y + Math.sin(angle) * radius;
        }

        myX = targetX; myY = targetY;
        
        // サーバーへ通知
        socket.emit('move', { x: myX, y: myY, roomId: myRoomId });

        document.getElementById('room-modal').style.display = 'none';
        document.getElementById('leaveRoomBtn').style.display = 'block';
        document.getElementById('room-status').style.display = 'block';
        
        checkAudioStatus();
    };
}

function closeRoomModal() { document.getElementById('room-modal').style.display = 'none'; }

function leaveMeetingRoom() {
    myRoomId = null;
    moveMe(myX, myY + 150); 
    document.getElementById('leaveRoomBtn').style.display = 'none';
    document.getElementById('room-status').style.display = 'none';
    checkAudioStatus();
}

function exitOffice() {
    if(confirm("退出しますか？")) location.reload();
}

function moveMe(x, y) {
    if (!socket) return;
    myX = Math.max(20, Math.min(x, WORLD_W-20));
    myY = Math.max(20, Math.min(y, WORLD_H-20));
    socket.emit('move', { x: myX, y: myY, roomId: myRoomId });
    checkAudioStatus();
}

// ----------------------
// 音声接続 (修正)
// ----------------------
function checkAudioStatus() {
    let canSpeak = false;

    if (myRoomId) {
        // 会議室: 自動ONにはしないがボタンは有効化
        canSpeak = true;
        micBtn.innerText = isMicMutedByUser ? "マイクOFF" : "マイクON";
        micBtn.disabled = false;
        micBtn.style.background = isMicMutedByUser ? "#e74c3c" : "#e67e22"; 
    } else if (myX < 600) {
        canSpeak = false;
        micBtn.innerText = "禁止エリア";
        micBtn.disabled = true;
        micBtn.style.background = "#555";
    } else {
        canSpeak = true;
        micBtn.innerText = isMicMutedByUser ? "マイクOFF" : "マイクON";
        micBtn.disabled = false;
        micBtn.style.background = isMicMutedByUser ? "#e74c3c" : "#27ae60"; 
    }

    setMicState(canSpeak && !isMicMutedByUser);
    // 強制的に接続更新を走らせる
    connectToUsers();
}

function connectToUsers() {
    if (!myPeer || !myStream) return;

    Object.keys(users).forEach(id => {
        if (id === myId) return;
        const u = users[id];
        let shouldConnect = false;

        // 接続条件チェック
        if (myRoomId) {
            // 自分は会議室: 相手も「同じ部屋」なら接続
            if (u.roomId === myRoomId) shouldConnect = true;
        } else {
            // 自分は外: 相手も「外」かつ「リビング(X>=600)」なら接続
            if (!u.roomId && myX >= 600 && u.x >= 600) shouldConnect = true;
        }

        if (shouldConnect) {
            if (!peers[id]) {
                const call = myPeer.call(u.peerId, myStream);
                peers[id] = call;
                handleStream(call);
            }
        } else {
            // 条件不一致なら切断
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
        // 重複チェック
        if (document.getElementById(call.peer)) return;
        
        const audio = document.createElement('audio');
        audio.id = call.peer;
        audio.srcObject = userAudio;
        audio.autoplay = true; 
        audio.playsInline = true; // スマホ用重要
        
        const spkId = document.getElementById('speakerSelectInGame').value;
        if(spkId && audio.setSinkId) audio.setSinkId(spkId).catch(e=>{});
        
        document.body.appendChild(audio);
    });
    call.on('close', () => {
        const el = document.getElementById(call.peer);
        if(el) el.remove();
    });
}

// ============================
// その他
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

function draw() {
    let camX = myX - canvas.width / 2;
    let camY = myY - canvas.height / 2;
    camX = Math.max(0, Math.min(camX, WORLD_W - canvas.width));
    camY = Math.max(0, Math.min(camY, WORLD_H - canvas.height));

    ctx.save();
    ctx.translate(-camX, -camY);

    // 背景
    ctx.fillStyle = "#f4f1ea"; ctx.fillRect(0, 0, WORLD_W, WORLD_H);
    ctx.fillStyle = "#e8ecef"; ctx.fillRect(0, 0, 600, WORLD_H); // Work Area
    ctx.fillStyle = "#bdc3c7";
    for(let i=0; i<5; i++) for(let j=0; j<3; j++) ctx.fillRect(100 + j*150, 200 + i*200, 100, 60);

    // 会議室
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

// スマホ移動
const spd = 10;
const setupBtn = (id, dx, dy) => {
    const b = document.getElementById(id);
    let i;
    const act = (e) => { 
        if(e.cancelable) e.preventDefault(); 
        if(!myRoomId) i=setInterval(()=>moveMe(myX+dx,myY+dy),50); 
    };
    b.addEventListener('touchstart', act);
    b.addEventListener('touchend', ()=>clearInterval(i));
};
setupBtn('d-up',0,-spd); setupBtn('d-down',0,spd); setupBtn('d-left',-spd,0); setupBtn('d-right',spd,0);