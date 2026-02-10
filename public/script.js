// ============================
// グローバル変数
// ============================
let socket = null, myPeer = null, myStream = null;
let users = {}, peers = {};
let myId = null;

// 初期位置
let myX = 1400, myY = 900; 
let myName = "ゲスト";
let myRoomId = null; 
let isMicMutedByUser = true;
let audioContext = null; 

// ★ズーム設定
let cameraScale = 1.0;
const MIN_ZOOM = 0.4; // 一番引いた状態
const MAX_ZOOM = 2.0; // 一番寄った状態

const bgImage = new Image();
bgImage.src = "bg.jpg"; 

const WORLD_W = 2000;
const WORLD_H = 1125;
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
const TALK_DISTANCE = 120; 

const MEETING_ROOMS = [
    { id: 'A', name: '大会議室 (ガラス張り)', type: 'rect', x: 40, y: 180, w: 680, h: 800, capacity: 10 },
    { id: 'B', name: 'ソファ席 (会議室B)', type: 'rect', x: 820, y: 550, w: 500, h: 450, capacity: 6 }
];

const ZONES = {
    SILENT: { name: "集中ブース (会話禁止)", check: (x, y) => (x > 750 && x < 1600 && y < 450), allowMic: false },
    LIVING: { name: "コミュニティハブ (距離会話)", check: (x, y) => true, allowMic: true }
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

// マウスホイールでズーム
canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    changeZoom(delta);
}, { passive: false });

// ズーム変更関数
function changeZoom(delta) {
    cameraScale += delta;
    cameraScale = Math.max(MIN_ZOOM, Math.min(cameraScale, MAX_ZOOM));
    // 画面再描画
    draw();
}

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
    socket.on('updateUsers', (data) => { users = data; updateVolumes(); });
    
    myPeer = new Peer();
    myPeer.on('open', peerId => socket.emit('enterRoom', { name: myName, peerId: peerId }));
    myPeer.on('call', call => { call.answer(myStream); handleStream(call); });

    setInterval(connectToUsers, 1500);
    setInterval(updateVolumes, 200);

    loop();
}

function loop() { draw(); requestAnimationFrame(loop); }

// ============================
// 音声・エリア制御
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
            statusText = "会話OK (近距離)";
            updateMicBtn(true, statusText);
        }
    }
    setMicState(canSpeak && !isMicMutedByUser);
    updateVolumes();
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
            if (u.roomId === myRoomId) shouldConnect = true;
        } else {
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

function updateVolumes() {
    Object.keys(users).forEach(targetId => {
        if (targetId === myId) return;
        const u = users[targetId];
        if (!u.peerId) return;
        const audioEl = document.getElementById("audio-" + u.peerId);
        if (!audioEl) return;

        let volume = 0;
        if (myRoomId) {
            if (u.roomId === myRoomId) volume = 1.0;
        } else {
            if (!u.roomId) {
                const dist = Math.sqrt((myX - u.x)**2 + (myY - u.y)**2);
                if (dist <= TALK_DISTANCE) volume = 1.0;
                else volume = 0;
            }
        }
        audioEl.volume = volume;
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
        audio.volume = 0; 
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
    // ★重要: クリック位置をズームを考慮して計算
    const pos = getWorldPos(e.clientX, e.clientY);
    
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
    updateVolumes();
}

function getCurrentZone() {
    if (ZONES.SILENT.check(myX, myY)) return ZONES.SILENT;
    return ZONES.LIVING;
}

function showRoomModal(room) {
    const count = Object.values(users).filter(u => u.roomId === room.id).length;
    if (count >= room.capacity) { alert("満員です"); return; }
    
    document.getElementById('room-title').innerText = room.name;
    document.getElementById('room-info').innerText = `定員: ${count}/${room.capacity}`;
    document.getElementById('room-modal').style.display = 'flex';
    
    document.getElementById('joinRoomBtn').onclick = () => {
        myRoomId = room.id;
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
    moveMe(1300, 900);
    document.getElementById('leaveRoomBtn').style.display = 'none';
    document.getElementById('room-status').style.display = 'none';
    checkAudioStatus();
}

// ============================
// 描画システム (ズーム対応)
// ============================
function draw() {
    // 1. スケール適用後の「画面に見えている範囲」の幅と高さを計算
    const visibleW = canvas.width / cameraScale;
    const visibleH = canvas.height / cameraScale;

    // 2. カメラ位置計算 (自分が中心になるように)
    let camX = myX - visibleW / 2;
    let camY = myY - visibleH / 2;

    // 3. 端っこの制限 (ズーム時は見切れ範囲が変わる)
    camX = Math.max(0, Math.min(camX, WORLD_W - visibleW));
    camY = Math.max(0, Math.min(camY, WORLD_H - visibleH));

    ctx.save();
    
    // ★重要: 先に拡大してから、カメラ位置へずらす
    ctx.scale(cameraScale, cameraScale);
    ctx.translate(-camX, -camY);

    // 背景
    if (bgImage.complete) {
        ctx.drawImage(bgImage, 0, 0, WORLD_W, WORLD_H);
    } else {
        ctx.fillStyle = "#eee"; ctx.fillRect(0, 0, WORLD_W, WORLD_H);
    }

    // 会議室枠線
    MEETING_ROOMS.forEach(r => {
        ctx.fillStyle = "rgba(41, 128, 185, 0.2)"; ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.strokeStyle = "rgba(41, 128, 185, 0.9)"; ctx.lineWidth = 4; ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.fillStyle = "rgba(0, 0, 0, 0.7)"; ctx.font = "bold 24px sans-serif"; ctx.fillText(r.name, r.x + 30, r.y + 40);
    });

    // 禁止エリア枠線
    ctx.fillStyle = "rgba(231, 76, 60, 0.1)"; ctx.fillRect(750, 0, 850, 450); 
    ctx.strokeStyle = "rgba(192, 57, 43, 0.9)"; ctx.lineWidth = 4; ctx.strokeRect(750, 0, 850, 450);
    ctx.fillStyle = "rgba(192, 57, 43, 1)"; ctx.font = "bold 20px sans-serif"; ctx.fillText("🚫 会話禁止 (Focus Zone)", 1050, 60);

    // 会話可能範囲の可視化
    if (!myRoomId && getCurrentZone() === ZONES.LIVING) {
        ctx.beginPath();
        ctx.arc(myX, myY, TALK_DISTANCE, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(46, 204, 113, 0.1)"; 
        ctx.fill();
        ctx.strokeStyle = "rgba(46, 204, 113, 0.5)"; ctx.lineWidth = 1; ctx.stroke();
    }

    // ユーザー
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

// ★重要: クリック位置をズーム率で補正してワールド座標に変換
function getWorldPos(cx, cy) {
    const visibleW = canvas.width / cameraScale;
    const visibleH = canvas.height / cameraScale;
    
    let camX = myX - visibleW / 2;
    let camY = myY - visibleH / 2;
    camX = Math.max(0, Math.min(camX, WORLD_W - visibleW));
    camY = Math.max(0, Math.min(camY, WORLD_H - visibleH));
    
    // 画面上のクリック位置をスケールで割って、カメラ位置を足す
    return { 
        x: (cx / cameraScale) + camX, 
        y: (cy / cameraScale) + camY 
    };
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