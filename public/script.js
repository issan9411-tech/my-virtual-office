// ============================
// グローバル変数 & 設定
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

// ズーム設定
let cameraScale = 1.0;
const MIN_ZOOM = 0.4; 
const MAX_ZOOM = 2.0; 

// 背景画像
const bgImage = new Image();
bgImage.src = "bg.jpg"; 

const WORLD_W = 2000;
const WORLD_H = 1125;
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

// ★会話距離 (アバター3人分) + マージン
// 近づく時は120pxで接続、離れる時は150pxで切断（チラつき防止）
const TALK_DISTANCE = 120; 
const DISCONNECT_DISTANCE = 150; 

// エリア設定
const MEETING_ROOMS = [
    { id: 'A', name: '大会議室 (ガラス張り)', type: 'rect', x: 40, y: 180, w: 680, h: 800, capacity: 10 },
    { id: 'B', name: 'ソファ席 (会議室B)', type: 'rect', x: 820, y: 550, w: 420, h: 450, capacity: 6 }
];

const ZONES = {
    SILENT: { 
        name: "集中ブース (会話禁止)", 
        check: (x, y) => (x > 750 && x < 1450 && y < 450), 
        allowMic: false 
    },
    LIVING: { 
        name: "コミュニティハブ (距離会話)", 
        check: (x, y) => true, 
        allowMic: true 
    }
};

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const micBtn = document.getElementById('micBtn');

// ============================
// セットアップ
// ============================
window.addEventListener('load', () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    if (isMobile) document.getElementById('d-pad').style.display = 'block';
});

canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    changeZoom(delta);
}, { passive: false });

function changeZoom(delta) {
    cameraScale += delta;
    cameraScale = Math.max(MIN_ZOOM, Math.min(cameraScale, MAX_ZOOM));
    draw();
}

async function startSetup() {
    initAudioContext();
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
        await getDevices('micSelect', 'speakerSelect');
        document.getElementById('start-overlay').style.display = 'none';
        document.getElementById('entry-modal').style.display = 'flex';
        
        const micSelect = document.getElementById('micSelect');
        micSelect.onchange = () => startMicTest('micSelect', 'mic-visualizer-bar-entry');
        startMicTest('micSelect', 'mic-visualizer-bar-entry');

    } catch (err) {
        alert("マイクの使用を許可してください。");
    }
}

function initAudioContext() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audioContext) audioContext = new AC();
    if (audioContext.state === 'suspended') audioContext.resume();
    // iOS対策の無音再生
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
    initAudioContext();

    const micId = document.getElementById('micSelect').value;
    
    // ★軽量化: 音質設定を落として負荷を下げる
    const constraints = { 
        audio: { 
            deviceId: micId ? { exact: micId } : undefined,
            echoCancellation: true, 
            noiseSuppression: true, 
            autoGainControl: true,
            channelCount: 1, // モノラルにする（通信量半減）
            sampleRate: 16000 // サンプルレートを下げる（音声には十分）
        } 
    };

    navigator.mediaDevices.getUserMedia(constraints)
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
    socket.on('updateUsers', (data) => { users = data; }); // 接続チェックは定期実行に任せる
    
    myPeer = new Peer();
    myPeer.on('open', peerId => socket.emit('enterRoom', { name: myName, peerId: peerId }));
    myPeer.on('call', call => {
        call.answer(myStream);
        handleStream(call);
    });

    // ★接続管理: 1秒に1回チェック（頻度を下げて軽くする）
    setInterval(manageConnections, 1000);
    loop();
}

function loop() { draw(); requestAnimationFrame(loop); }

// ============================
// ★重要: 接続の切断・接続管理 (軽量化の核心)
// ============================
function manageConnections() {
    if (!myPeer || !myStream || !myId) return;
    const myZone = getCurrentZone();

    // 1. マイクボタンの表示更新
    updateMicStatus(myZone);

    // 2. ユーザーごとの接続判定
    Object.keys(users).forEach(targetId => {
        if (targetId === myId) return;
        const u = users[targetId];
        if (!u.peerId) return;

        let shouldConnect = false;

        // --- 判定ロジック ---
        if (myRoomId) {
            // 会議室: 同じ部屋なら接続
            if (u.roomId === myRoomId) shouldConnect = true;
        } else {
            // リビング: お互い部屋なし
            if (!u.roomId) {
                const dist = Math.sqrt((myX - u.x)**2 + (myY - u.y)**2);
                const uZoneIsSilent = ZONES.SILENT.check(u.x, u.y);
                
                // 禁止エリア外 かつ 距離内なら接続
                if (myZone.allowMic && !uZoneIsSilent) {
                    if (dist <= TALK_DISTANCE) {
                        shouldConnect = true;
                    } else if (dist <= DISCONNECT_DISTANCE && peers[u.peerId]) {
                        // 少し離れても、既に繋がっていれば維持（チラつき防止）
                        shouldConnect = true;
                    }
                }
            }
        }

        // --- 実行 ---
        if (shouldConnect) {
            // 未接続なら繋ぐ
            if (!peers[u.peerId]) {
                // 重複防止: IDが大きい方からかける
                if (myPeer.id > u.peerId) {
                    console.log("接続開始:", u.name);
                    const call = myPeer.call(u.peerId, myStream);
                    peers[u.peerId] = call;
                    handleStream(call);
                }
            }
        } else {
            // ★重要: 不要になったら即切断（負荷軽減）
            if (peers[u.peerId]) {
                console.log("切断:", u.name);
                peers[u.peerId].close(); // WebRTC切断
                delete peers[u.peerId];  // 管理から削除
                removeAudio(u.peerId);   // 音声タグ削除
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
        audio.autoplay = true; 
        audio.playsInline = true;
        
        // スピーカー適用
        const spkId = document.getElementById('speakerSelectInGame') ? document.getElementById('speakerSelectInGame').value : null;
        if(spkId && audio.setSinkId) audio.setSinkId(spkId).catch(e=>{});
        
        document.body.appendChild(audio);
    });
    
    // エラーや切断時のクリーンアップ
    const cleanup = () => {
        removeAudio(call.peer);
        if (peers[call.peer]) delete peers[call.peer];
    };
    call.on('close', cleanup);
    call.on('error', cleanup);
}

function removeAudio(peerId) {
    const el = document.getElementById("audio-" + peerId);
    if(el) el.remove();
}

function updateMicStatus(currentZone) {
    let canSpeak = false;
    let statusText = "";

    if (myRoomId) {
        canSpeak = true;
        statusText = "会議中";
    } else {
        if (!currentZone.allowMic) {
            canSpeak = false;
            statusText = "会話禁止エリア";
        } else {
            canSpeak = true;
            statusText = "会話OK (近距離)";
        }
    }

    // ボタンの見た目更新
    if (!canSpeak) {
        micBtn.disabled = true;
        micBtn.innerText = statusText;
        micBtn.style.background = "#555";
    } else {
        micBtn.disabled = false;
        micBtn.innerText = isMicMutedByUser ? "マイクOFF" : "マイクON";
        micBtn.style.background = isMicMutedByUser ? "#e74c3c" : "#27ae60";
    }
    
    setMicState(canSpeak && !isMicMutedByUser);
}

// ============================
// 移動 & 判定
// ============================
canvas.addEventListener('click', (e) => {
    if (myRoomId) return;
    const pos = getWorldPos(e.clientX, e.clientY);
    
    const room = MEETING_ROOMS.find(r => 
        pos.x >= r.x && pos.x <= r.x+r.w && pos.y >= r.y && pos.y <= r.y+r.h
    );

    if (room) showRoomModal(room);
    else moveMe(pos.x, pos.y);
});

// ★軽量化: 移動の送信頻度を制限
let lastMoveTime = 0;
function moveMe(x, y) {
    myX = Math.max(20, Math.min(x, WORLD_W-20));
    myY = Math.max(20, Math.min(y, WORLD_H-20));
    
    const now = Date.now();
    // 50ms (秒間20回) 以上経過していないと送信しない
    if (socket && (now - lastMoveTime > 50)) {
        socket.emit('move', { x: myX, y: myY, roomId: myRoomId });
        lastMoveTime = now;
    }
    
    // 自分のマイク状態更新は即時反映
    const myZone = getCurrentZone();
    updateMicStatus(myZone);
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
    
    const joinBtn = document.getElementById('joinRoomBtn');
    const newBtn = joinBtn.cloneNode(true);
    joinBtn.parentNode.replaceChild(newBtn, joinBtn);

    newBtn.onclick = async () => {
        initAudioContext();
        myRoomId = room.id;
        myX = room.x + room.w/2 - 50 + Math.random()*100;
        myY = room.y + room.h/2 - 50 + Math.random()*100;
        socket.emit('move', { x: myX, y: myY, roomId: myRoomId });
        
        document.getElementById('room-modal').style.display = 'none';
        document.getElementById('leaveRoomBtn').style.display = 'block';
        document.getElementById('room-status').style.display = 'block';
        if(myStream) myStream.getAudioTracks().forEach(t => t.enabled = true);
        
        // 接続状態を即座に再計算
        manageConnections();
    };
}

function closeRoomModal() { document.getElementById('room-modal').style.display = 'none'; }

function leaveMeetingRoom() {
    myRoomId = null;
    moveMe(1300, 900);
    document.getElementById('leaveRoomBtn').style.display = 'none';
    document.getElementById('room-status').style.display = 'none';
    manageConnections();
}

// ============================
// 描画
// ============================
function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0); 
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#2c3e50"; 
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const visibleW = canvas.width / cameraScale;
    const visibleH = canvas.height / cameraScale;

    let camX = myX - visibleW / 2;
    let camY = myY - visibleH / 2;
    camX = Math.max(0, Math.min(camX, WORLD_W - visibleW));
    camY = Math.max(0, Math.min(camY, WORLD_H - visibleH));

    ctx.save();
    ctx.scale(cameraScale, cameraScale);
    ctx.translate(-camX, -camY);

    if (bgImage.complete) {
        ctx.drawImage(bgImage, 0, 0, WORLD_W, WORLD_H);
    } else {
        ctx.fillStyle = "#eee"; ctx.fillRect(0, 0, WORLD_W, WORLD_H);
    }

    MEETING_ROOMS.forEach(r => {
        ctx.fillStyle = "rgba(41, 128, 185, 0.2)"; ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.strokeStyle = "rgba(41, 128, 185, 0.9)"; ctx.lineWidth = 4; ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.fillStyle = "rgba(0, 0, 0, 0.7)"; ctx.font = "bold 24px sans-serif"; ctx.fillText(r.name, r.x + 30, r.y + 40);
    });

    ctx.fillStyle = "rgba(231, 76, 60, 0.1)"; ctx.fillRect(750, 0, 700, 450); 
    ctx.strokeStyle = "rgba(192, 57, 43, 0.9)"; ctx.lineWidth = 4; ctx.strokeRect(750, 0, 700, 450);
    ctx.fillStyle = "rgba(192, 57, 43, 1)"; ctx.font = "bold 20px sans-serif"; ctx.fillText("🚫 会話禁止 (Focus Zone)", 900, 60);

    if (!myRoomId && getCurrentZone() === ZONES.LIVING) {
        ctx.beginPath();
        ctx.arc(myX, myY, TALK_DISTANCE, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(46, 204, 113, 0.1)"; 
        ctx.fill();
        ctx.strokeStyle = "rgba(46, 204, 113, 0.5)"; ctx.lineWidth = 1; ctx.stroke();
    }

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
    const visibleW = canvas.width / cameraScale;
    const visibleH = canvas.height / cameraScale;
    let camX = myX - visibleW / 2;
    let camY = myY - visibleH / 2;
    camX = Math.max(0, Math.min(camX, WORLD_W - visibleW));
    camY = Math.max(0, Math.min(camY, WORLD_H - visibleH));
    return { x: (cx / cameraScale) + camX, y: (cy / cameraScale) + camY };
}

// ユーティリティ & 設定
function toggleMic() { isMicMutedByUser = !isMicMutedByUser; updateMicStatus(getCurrentZone()); }
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

function openSettings() { 
    getDevices('micSelectInGame', 'speakerSelectInGame').then(() => {
        if (myStream) {
            const currentMicId = myStream.getAudioTracks()[0].getSettings().deviceId;
            if (currentMicId) document.getElementById('micSelectInGame').value = currentMicId;
        }
        const speakerSelect = document.getElementById('speakerSelectInGame');
        // 現在のスピーカーIDがあればセット（Chrome用）
        // (簡易実装: 本来は変数を保持すべきだが、apply時にDOMから取る)
        
        const micSelect = document.getElementById('micSelectInGame');
        micSelect.onchange = () => startMicTest('micSelectInGame', 'mic-visualizer-bar-game');
        startMicTest('micSelectInGame', 'mic-visualizer-bar-game');
    });
    document.getElementById('settings-modal').style.display = 'flex'; 
}

function closeSettings() { document.getElementById('settings-modal').style.display = 'none'; }

async function applySettings() {
    const micId = document.getElementById('micSelectInGame').value;
    const spkId = document.getElementById('speakerSelectInGame').value;

    if (micId) {
        try {
            // 適用時も軽量設定で取得
            const newStream = await navigator.mediaDevices.getUserMedia({
                audio: { 
                    deviceId: { exact: micId }, 
                    echoCancellation: true, noiseSuppression: true, autoGainControl: true,
                    channelCount: 1, sampleRate: 16000
                }
            });
            if (myStream) myStream.getTracks().forEach(t => t.stop());
            myStream = newStream;
            setMicState(!isMicMutedByUser); 
            // 接続中のピアに新しいトラックを送る
            Object.values(peers).forEach(call => {
                const sender = call.peerConnection.getSenders().find(s => s.track.kind === 'audio');
                if (sender) sender.replaceTrack(newStream.getAudioTracks()[0]);
            });
            alert("設定を適用しました");
        } catch (e) { alert("失敗: " + e); }
    }
    if (spkId) {
        document.querySelectorAll('audio').forEach(a => {
            if (a.setSinkId) a.setSinkId(spkId).catch(e=>{});
        });
    }
    closeSettings();
}

function testSpeaker() {
    const AC = window.AudioContext || window.webkitAudioContext; const ctx = new AC(); const osc = ctx.createOscillator();
    const spkId = document.getElementById('speakerSelect').value;
    if (spkId && ctx.setSinkId) ctx.setSinkId(spkId).catch(e=>{});
    osc.connect(ctx.destination); osc.frequency.value = 523.25; osc.start(); osc.stop(ctx.currentTime + 0.3);
}

function startMicTest(selectId, barId) {
    const micId = document.getElementById(selectId).value; if(!micId) return;
    navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: micId } } }).then(s => {
        const AC = window.AudioContext || window.webkitAudioContext; const ctx = new AC(); const src = ctx.createMediaStreamSource(s);
        const anl = ctx.createAnalyser(); anl.fftSize = 256; src.connect(anl);
        const data = new Uint8Array(anl.frequencyBinCount); const bar = document.getElementById(barId);
        const upd = () => { 
            const m1 = document.getElementById('entry-modal'), m2 = document.getElementById('settings-modal');
            if(m1.style.display==='none' && m2.style.display==='none') { s.getTracks().forEach(t=>t.stop()); ctx.close(); return; }
            anl.getByteFrequencyData(data); let sum=0; for(let i=0;i<data.length;i++)sum+=data[i]; 
            if(bar) bar.style.width=Math.min(100,(sum/data.length)*3)+'%'; 
            requestAnimationFrame(upd); 
        }; upd();
    }).catch(e=>{});
}

const spd = 10;
const setupBtn = (id, dx, dy) => {
    const b = document.getElementById(id); let i;
    const act = (e) => { if(e.cancelable) e.preventDefault(); if(!myRoomId) i=setInterval(()=>moveMe(myX+dx,myY+dy),50); };
    b.addEventListener('touchstart', act); b.addEventListener('touchend', ()=>clearInterval(i));
};
setupBtn('d-up',0,-spd); setupBtn('d-down',0,spd); setupBtn('d-left',-spd,0); setupBtn('d-right',spd,0);