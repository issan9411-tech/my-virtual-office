// ============================
// グローバル変数
// ============================
let socket = null, myPeer = null, myStream = null;
let users = {}, peers = {};
let myId = null;
let myX = 1500, myY = 1000; // 初期位置をリビング側に変更
let myName = "ゲスト";
let myRoomId = null; 
let isMicMutedByUser = true;
let audioContext = null; 

// 背景画像の準備
const bgImage = new Image();
bgImage.src = "bg.jpg"; // publicフォルダの画像ファイル名

// ワールドサイズ (画像の比率に合わせて調整)
const WORLD_W = 2000;
const WORLD_H = 1125; // 16:9の比率に近い形に変更
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

// 会議室データ (画像の左側のガラス部屋に合わせる)
const MEETING_ROOMS = [
    { 
        id: 'A', 
        name: '大会議室', 
        type: 'rect', 
        x: 50, y: 250, w: 650, h: 750, // 左側のガラス部屋エリア
        capacity: 8 
    }
];

// エリア定義 (画像のレイアウトに合わせる)
const ZONES = {
    SILENT: { 
        name: "集中ブース (会話禁止)", 
        allowMic: false,
        // 右上のエリア (Xが700以上 かつ Yが500以下)
        check: (x, y) => x > 700 && y < 500 
    },
    MEETING_AREA: {
        name: "会議室エリア",
        allowMic: true, // 会議室ロジック側で制御されるのでここはtrueでOK
        // 左側のエリア
        check: (x, y) => x < 700
    },
    LIVING: { 
        name: "コミュニティハブ (会話OK)", 
        allowMic: true,
        // それ以外（右下）
        check: (x, y) => true 
    }
};


const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const micBtn = document.getElementById('micBtn');

// ============================
// 1. セットアップ開始
// ============================
window.addEventListener('load', () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    if (isMobile) document.getElementById('d-pad').style.display = 'block';
});

async function startSetup() {
    unlockAudioContext();
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
        await getDevices('micSelect', 'speakerSelect');
        document.getElementById('start-overlay').style.display = 'none';
        document.getElementById('entry-modal').style.display = 'flex';
        document.getElementById('micSelect').addEventListener('change', startMicTest);
        startMicTest();
    } catch (err) {
        alert("マイクの使用を許可してください。");
        console.error(err);
    }
}

function unlockAudioContext() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(0);
    osc.stop(0.1);
}

// ============================
// テスト機能
// ============================
function testSpeaker() {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const spkId = document.getElementById('speakerSelect').value;
    if (spkId && ctx.setSinkId) ctx.setSinkId(spkId).catch(e=>{});
    osc.connect(ctx.destination);
    osc.frequency.value = 523.25;
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
            bar.style.width = Math.min(100, (sum / data.length) * 3) + '%';
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
    
    const micId = document.getElementById('micSelect').value;
    navigator.mediaDevices.getUserMedia({ 
        audio: { 
            deviceId: micId ? { exact: micId } : undefined,
            echoCancellation: true, noiseSuppression: true
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
    socket.on('updateUsers', (data) => { users = data; connectToUsers(); });
    myPeer = new Peer();
    myPeer.on('open', id => socket.emit('enterRoom', { name: myName, peerId: id }));
    myPeer.on('call', call => { call.answer(myStream); handleStream(call); });
    loop();
}

function loop() { draw(); requestAnimationFrame(loop); }

// ============================
// 移動 & エリア判定ロジック
// ============================
canvas.addEventListener('click', (e) => {
    if (myRoomId) return;
    const pos = getWorldPos(e.clientX, e.clientY);
    
    // 会議室クリック判定
    const room = MEETING_ROOMS.find(r => 
        pos.x >= r.x && pos.x <= r.x+r.w && pos.y >= r.y && pos.y <= r.y+r.h
    );

    if (room) showRoomModal(room);
    else moveMe(pos.x, pos.y);
});

function moveMe(x, y) {
    if (!socket) return;
    myX = Math.max(20, Math.min(x, WORLD_W-20));
    myY = Math.max(20, Math.min(y, WORLD_H-20));
    socket.emit('move', { x: myX, y: myY, roomId: myRoomId });
    checkAudioStatus();
}

// 現在の座標からエリア情報を取得
function getCurrentZone() {
    if (ZONES.SILENT.check(myX, myY)) return ZONES.SILENT;
    if (ZONES.MEETING_AREA.check(myX, myY)) return ZONES.MEETING_AREA;
    return ZONES.LIVING;
}

// ============================
// 音声制御 & 会議室
// ============================
function showRoomModal(room) {
    const count = Object.values(users).filter(u => u.roomId === room.id).length;
    if (count >= room.capacity) { alert("満員です"); return; }
    
    document.getElementById('room-title').innerText = room.name;
    document.getElementById('room-info').innerText = `定員: ${count}/${room.capacity}`;
    document.getElementById('room-modal').style.display = 'flex';
    
    document.getElementById('joinRoomBtn').onclick = () => {
        myRoomId = room.id;
        // 部屋内のランダム位置
        myX = room.x + 50 + Math.random() * (room.w - 100);
        myY = room.y + 50 + Math.random() * (room.h - 100);
        
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
    // 部屋の外（リビング側）へ排出
    moveMe(900, 800); 
    document.getElementById('leaveRoomBtn').style.display = 'none';
    document.getElementById('room-status').style.display = 'none';
    checkAudioStatus();
}

function checkAudioStatus() {
    let canSpeak = false;
    const currentZone = getCurrentZone();

    if (myRoomId) {
        // 会議室中
        canSpeak = true;
        micBtn.innerText = isMicMutedByUser ? "マイクOFF" : "マイクON";
        micBtn.disabled = false;
        micBtn.style.background = isMicMutedByUser ? "#e74c3c" : "#e67e22";
    } else {
        // 通常エリア
        if (!currentZone.allowMic) {
            // 禁止エリア
            canSpeak = false;
            micBtn.innerText = "会話禁止エリア";
            micBtn.disabled = true;
            micBtn.style.background = "#555";
        } else {
            // リビング
            canSpeak = true;
            micBtn.innerText = isMicMutedByUser ? "マイクOFF" : "マイクON";
            micBtn.disabled = false;
            micBtn.style.background = isMicMutedByUser ? "#e74c3c" : "#27ae60"; 
        }
    }

    setMicState(canSpeak && !isMicMutedByUser);
    connectToUsers();
}

function connectToUsers() {
    if (!myPeer || !myStream) return;
    const myZone = getCurrentZone();

    Object.keys(users).forEach(id => {
        if (id === myId) return;
        const u = users[id];
        let shouldConnect = false;

        if (myRoomId) {
            // 会議室: 同じ部屋の人
            if (u.roomId === myRoomId) shouldConnect = true;
        } else {
            // 通常: 相手も部屋なし & 禁止エリア以外 & リビング同士
            // ※簡易化のため「お互い禁止エリア以外」なら接続可とする
            // 相手のエリア判定
            let uZoneName = "LIVING";
            if (ZONES.SILENT.check(u.x, u.y)) uZoneName = "SILENT";
            
            if (!u.roomId && myZone.allowMic && uZoneName !== "SILENT") {
                shouldConnect = true;
            }
        }

        if (shouldConnect) {
            if (!peers[id]) {
                const call = myPeer.call(u.peerId, myStream);
                peers[id] = call;
                handleStream(call);
            }
        } else {
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
        if(spkId && audio.setSinkId) audio.setSinkId(spkId).catch(e=>{});
        document.body.appendChild(audio);
    });
    call.on('close', () => {
        const el = document.getElementById(call.peer);
        if(el) el.remove();
    });
}

// ============================
// 描画システム (背景画像対応)
// ============================
function draw() {
    let camX = myX - canvas.width / 2;
    let camY = myY - canvas.height / 2;
    camX = Math.max(0, Math.min(camX, WORLD_W - canvas.width));
    camY = Math.max(0, Math.min(camY, WORLD_H - canvas.height));

    ctx.save();
    ctx.translate(-camX, -camY);

    // 1. 背景画像を描画
    if (bgImage.complete) {
        ctx.drawImage(bgImage, 0, 0, WORLD_W, WORLD_H);
    } else {
        // 画像読み込み前は仮の背景
        ctx.fillStyle = "#f4f1ea"; ctx.fillRect(0, 0, WORLD_W, WORLD_H);
        ctx.fillStyle = "#000"; ctx.fillText("Loading Image...", 100, 100);
    }

    // 2. 会議室の当たり判定を可視化（デバッグ用：半透明で表示）
    // 実際に画像があるので、薄く枠だけ表示する等おしゃれにしてもOK
    MEETING_ROOMS.forEach(r => {
        // マウスオーバーしたときに分かりやすくするため、薄い枠線だけ描く
        ctx.strokeStyle = "rgba(52, 152, 219, 0.3)"; 
        ctx.lineWidth = 2;
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        
        // 部屋名
        ctx.fillStyle = "rgba(0,0,0,0.5)"; 
        ctx.font = "bold 20px sans-serif";
        ctx.fillText(r.name, r.x + 20, r.y + 40);
    });
    
    // 禁止エリアの文字表示（画像の上に重ねる）
    ctx.fillStyle = "rgba(231, 76, 60, 0.8)";
    ctx.font = "bold 30px sans-serif";
    ctx.fillText("🔇 マイクOFFエリア", 1000, 200);

    // 3. ユーザー描画
    Object.keys(users).forEach(id => {
        const u = users[id];
        ctx.fillStyle = (id === myId) ? '#e74c3c' : '#3498db';
        
        // 影をつける
        ctx.shadowColor = "rgba(0,0,0,0.3)";
        ctx.shadowBlur = 10;
        
        ctx.beginPath(); ctx.arc(u.x, u.y, 20, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0; // 影リセット

        // 名前
        ctx.fillStyle = "#fff"; 
        ctx.strokeStyle = "#000";
        ctx.lineWidth = 3;
        ctx.font = "bold 14px sans-serif"; 
        ctx.textAlign = "center";
        ctx.strokeText(u.name, u.x, u.y - 30);
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

// その他共通関数
function toggleMic() { isMicMutedByUser = !isMicMutedByUser; checkAudioStatus(); }
function setMicState(isOn) { if (myStream && myStream.getAudioTracks()[0]) myStream.getAudioTracks()[0].enabled = isOn; }
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
function openSettings() { getDevices('micSelectInGame', 'speakerSelectInGame'); document.getElementById('settings-modal').style.display = 'flex'; }
function closeSettings() { document.getElementById('settings-modal').style.display = 'none'; }
function exitOffice() { if(confirm("退出しますか？")) location.reload(); }
const spd = 10;
const setupBtn = (id, dx, dy) => {
    const b = document.getElementById(id); let i;
    const act = (e) => { if(e.cancelable) e.preventDefault(); if(!myRoomId) i=setInterval(()=>moveMe(myX+dx,myY+dy),50); };
    b.addEventListener('touchstart', act); b.addEventListener('touchend', ()=>clearInterval(i));
};
setupBtn('d-up',0,-spd); setupBtn('d-down',0,spd); setupBtn('d-left',-spd,0); setupBtn('d-right',spd,0);