// ============================
// グローバル変数
// ============================
let socket = null, myPeer = null, myStream = null;
let users = {}, peers = {};
let myId = null;

// 初期位置：右下のカフェエリア付近
let myX = 1400, myY = 900; 
let myName = "ゲスト";
let myRoomId = null; 
let isMicMutedByUser = true;
let audioContext = null; 

// 背景画像の準備
const bgImage = new Image();
bgImage.src = "bg.jpg"; 

// ワールドサイズ (16:9)
const WORLD_W = 2000;
const WORLD_H = 1125;
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

// ============================
// エリア・座標設定 (修正版)
// ============================

// 会議室データ
const MEETING_ROOMS = [
    { 
        id: 'A', 
        name: '大会議室 (ガラス張り)', 
        type: 'rect', 
        // 左側のガラス部屋全体
        x: 40, y: 180, w: 680, h: 800, 
        capacity: 10 
    },
    { 
        id: 'B', 
        name: 'ソファ席 (会議室B)', 
        type: 'rect', 
        // 真ん中の青いソファ3つがあるエリア
        x: 820, y: 550, w: 500, h: 450, 
        capacity: 6 
    }
];

// エリア定義
const ZONES = {
    // 集中ブース (奥の白いポッド4つ周辺)
    SILENT: { 
        name: "集中ブース (会話禁止)", 
        // 奥の壁沿いエリア
        check: (x, y) => (x > 750 && x < 1600 && y < 450),
        allowMic: false
    },
    // その他 (リビング/カフェ)
    LIVING: { 
        name: "コミュニティハブ (会話OK)", 
        check: (x, y) => true, 
        allowMic: true
    }
};

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const micBtn = document.getElementById('micBtn');

// ============================
// 1. セットアップ
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
        alert("マイクの使用を許可してください");
    }
}

function unlockAudioContext() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioContext = new AC();
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    gain.gain.value = 0;
    osc.connect(gain);
    gain.connect(audioContext.destination);
    osc.start(0);
    osc.stop(0.1);
}

// ============================
// 入室処理
// ============================
document.getElementById('enterGameBtn').addEventListener('click', async () => {
    const nameInput = document.getElementById('username');
    if (!nameInput.value) { alert("名前を入力してください"); return; }
    myName = nameInput.value;
    document.getElementById('entry-modal').style.display = 'none';
    
    if (audioContext && audioContext.state === 'suspended') await audioContext.resume();

    const micId = document.getElementById('micSelect').value;
    navigator.mediaDevices.getUserMedia({ 
        audio: { 
            deviceId: micId ? { exact: micId } : undefined,
            echoCancellation: true, noiseSuppression: true, autoGainControl: true
        } 
    })
    .then(stream => {
        myStream = stream;
        setMicState(false);
        startConnection();
    })
    .catch(err => alert("マイクエラー: " + err));
});

function startConnection() {
    socket = io();
    socket.on('connect', () => { myId = socket.id; });
    socket.on('updateUsers', (data) => { users = data; connectToUsers(); });
    myPeer = new Peer();
    myPeer.on('open', peerId => socket.emit('enterRoom', { name: myName, peerId: peerId }));
    
    myPeer.on('call', call => {
        call.answer(myStream);
        handleStream(call);
    });

    loop();
}

function loop() { draw(); requestAnimationFrame(loop); }

// ============================
// 音声接続ロジック
// ============================
function checkAudioStatus() {
    const currentZone = getCurrentZone();
    let canSpeak = false;
    let statusText = "";

    if (myRoomId) {
        canSpeak = true;
        statusText = "会議中";
        updateMicBtn(true, statusText);
    } else {
        if (!currentZone.allowMic) {
            canSpeak = false;
            statusText = "会話禁止エリア";
            updateMicBtn(false, statusText);
        } else {
            canSpeak = true;
            statusText = "会話OK";
            updateMicBtn(true, statusText);
        }
    }

    setMicState(canSpeak && !isMicMutedByUser);
    connectToUsers();
}

function updateMicBtn(enabled, text) {
    if (!enabled) {
        micBtn.disabled = true;
        micBtn.innerText = text;
        micBtn.style.background = "#555";
    } else {
        micBtn.disabled = false;
        micBtn.innerText = isMicMutedByUser ? "マイクOFF" : "マイクON";
        micBtn.style.background = isMicMutedByUser ? "#e74c3c" : "#27ae60";
    }
}

function connectToUsers() {
    if (!myPeer || !myStream || !myId) return;
    const myZone = getCurrentZone();

    Object.keys(users).forEach(targetId => {
        if (targetId === myId) return;
        const u = users[targetId];
        if (!u.peerId) return;

        let shouldConnect = false;

        if (myRoomId) {
            // 会議室: 同じ部屋の人
            if (u.roomId === myRoomId) shouldConnect = true;
        } else {
            // 通常: 相手も部屋なし & 相手が禁止エリアでない & 自分が禁止エリアでない
            if (!u.roomId) {
                const uZoneIsSilent = ZONES.SILENT.check(u.x, u.y);
                if (myZone.allowMic && !uZoneIsSilent) {
                    shouldConnect = true;
                }
            }
        }

        if (shouldConnect) {
            if (!peers[u.peerId]) {
                if (myPeer.id > u.peerId) {
                    const call = myPeer.call(u.peerId, myStream);
                    peers[u.peerId] = call;
                    handleStream(call);
                }
            }
        } else {
            if (peers[u.peerId]) {
                peers[u.peerId].close();
                delete peers[u.peerId];
                removeAudio(u.peerId);
            }
        }
    });
}

function handleStream(call) {
    call.on('stream', remoteStream => {
        if (document.getElementById("audio-" + call.peer)) return;
        const audio = document.createElement('audio');
        audio.id = "audio-" + call.peer;
        audio.srcObject = remoteStream;
        audio.autoplay = true; audio.playsInline = true;
        
        const spkId = document.getElementById('speakerSelectInGame').value;
        if(spkId && audio.setSinkId) audio.setSinkId(spkId).catch(e=>{});
        document.body.appendChild(audio);
    });
    call.on('close', () => { removeAudio(call.peer); delete peers[call.peer]; });
    call.on('error', () => { removeAudio(call.peer); delete peers[call.peer]; });
}

function removeAudio(peerId) {
    const el = document.getElementById("audio-" + peerId);
    if(el) el.remove();
}

// ============================
// 移動 & 判定
// ============================
canvas.addEventListener('click', (e) => {
    if (myRoomId) return;
    const pos = getWorldPos(e.clientX, e.clientY);
    
    // 会議室判定
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

function getCurrentZone() {
    if (ZONES.SILENT.check(myX, myY)) return ZONES.SILENT;
    return ZONES.LIVING;
}

// 会議室入室
function showRoomModal(room) {
    const count = Object.values(users).filter(u => u.roomId === room.id).length;
    if (count >= room.capacity) { alert("満員です"); return; }
    
    document.getElementById('room-title').innerText = room.name;
    document.getElementById('room-info').innerText = `定員: ${count}/${room.capacity}`;
    document.getElementById('room-modal').style.display = 'flex';
    
    document.getElementById('joinRoomBtn').onclick = () => {
        myRoomId = room.id;
        // 部屋の中央付近へワープ (重なり防止のランダム)
        myX = room.x + room.w/2 - 50 + Math.random()*100;
        myY = room.y + room.h/2 - 50 + Math.random()*100;
        
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
    moveMe(1300, 900); // 退出後は右下のカフェ付近へ
    document.getElementById('leaveRoomBtn').style.display = 'none';
    document.getElementById('room-status').style.display = 'none';
    checkAudioStatus();
}

// ============================
// 描画
// ============================
function draw() {
    let camX = myX - canvas.width / 2;
    let camY = myY - canvas.height / 2;
    camX = Math.max(0, Math.min(camX, WORLD_W - canvas.width));
    camY = Math.max(0, Math.min(camY, WORLD_H - canvas.height));

    ctx.save();
    ctx.translate(-camX, -camY);

    if (bgImage.complete) {
        ctx.drawImage(bgImage, 0, 0, WORLD_W, WORLD_H);
    } else {
        ctx.fillStyle = "#eee"; ctx.fillRect(0, 0, WORLD_W, WORLD_H);
        ctx.fillStyle = "#000"; ctx.fillText("Loading Background...", 100, 100);
    }

    // --- エリア判定の可視化（濃い枠線に変更） ---
    
    // 1. 会議室エリア
    MEETING_ROOMS.forEach(r => {
        // 中身は薄く
        ctx.fillStyle = "rgba(41, 128, 185, 0.2)"; 
        ctx.fillRect(r.x, r.y, r.w, r.h);
        
        // ★枠線を濃く太く
        ctx.strokeStyle = "rgba(41, 128, 185, 0.9)"; 
        ctx.lineWidth = 4; // 太く
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        
        // テキスト
        ctx.fillStyle = "rgba(0, 0, 0, 0.7)"; 
        ctx.font = "bold 24px sans-serif";
        ctx.fillText(r.name, r.x + 30, r.y + 40);
    });

    // 2. 集中ブースエリア (x:750~1600, y:0~450)
    ctx.fillStyle = "rgba(231, 76, 60, 0.1)";
    ctx.fillRect(750, 0, 850, 450); 
    
    // ★枠線を濃く太く
    ctx.strokeStyle = "rgba(192, 57, 43, 0.9)";
    ctx.lineWidth = 4;
    ctx.strokeRect(750, 0, 850, 450);

    ctx.fillStyle = "rgba(192, 57, 43, 1)";
    ctx.font = "bold 20px sans-serif";
    ctx.fillText("🚫 会話禁止 (Focus Zone)", 1050, 60);


    // ユーザー描画
    Object.keys(users).forEach(id => {
        const u = users[id];
        ctx.shadowColor = "rgba(0,0,0,0.3)"; ctx.shadowBlur = 10;
        
        ctx.fillStyle = (id === myId) ? '#e74c3c' : '#3498db';
        ctx.beginPath(); ctx.arc(u.x, u.y, 20, 0, Math.PI * 2); ctx.fill();
        
        ctx.shadowBlur = 0;
        ctx.fillStyle = "#fff"; ctx.strokeStyle = "#000"; ctx.lineWidth = 3;
        ctx.font = "bold 14px sans-serif"; ctx.textAlign = "center";
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

// ユーティリティ
function toggleMic() { isMicMutedByUser = !isMicMutedByUser; checkAudioStatus(); }
function setMicState(isOn) { if (myStream && myStream.getAudioTracks()[0]) myStream.getAudioTracks()[0].enabled = isOn; }
function exitOffice() { if(confirm("退出しますか？")) location.reload(); }

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
function testSpeaker() {
    const AC = window.AudioContext || window.webkitAudioContext; const ctx = new AC(); const osc = ctx.createOscillator();
    const spkId = document.getElementById('speakerSelect').value;
    if (spkId && ctx.setSinkId) ctx.setSinkId(spkId).catch(e=>{});
    osc.connect(ctx.destination); osc.frequency.value = 523.25; osc.start(); osc.stop(ctx.currentTime + 0.3);
}
function startMicTest() {
    const micId = document.getElementById('micSelect').value; if(!micId) return;
    navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: micId } } }).then(s => {
        const AC = window.AudioContext || window.webkitAudioContext; const ctx = new AC(); const src = ctx.createMediaStreamSource(s);
        const anl = ctx.createAnalyser(); anl.fftSize = 256; src.connect(anl);
        const data = new Uint8Array(anl.frequencyBinCount); const bar = document.getElementById('mic-visualizer-bar');
        const upd = () => { if(document.getElementById('entry-modal').style.display==='none')return; anl.getByteFrequencyData(data); let sum=0; for(let i=0;i<data.length;i++)sum+=data[i]; bar.style.width=Math.min(100,(sum/data.length)*3)+'%'; requestAnimationFrame(upd); }; upd();
    }).catch(e=>{});
}

const spd = 10;
const setupBtn = (id, dx, dy) => {
    const b = document.getElementById(id); let i;
    const act = (e) => { if(e.cancelable) e.preventDefault(); if(!myRoomId) i=setInterval(()=>moveMe(myX+dx,myY+dy),50); };
    b.addEventListener('touchstart', act); b.addEventListener('touchend', ()=>clearInterval(i));
};
setupBtn('d-up',0,-spd); setupBtn('d-down',0,spd); setupBtn('d-left',-spd,0); setupBtn('d-right',spd,0);