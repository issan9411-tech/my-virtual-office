// ============================
// グローバル変数
// ============================
let socket = null, myPeer = null, myStream = null;
let users = {}, peers = {}; // peers: 通話オブジェクト管理
let myId = null;

// ★初期位置をソファエリア（右下）に変更
let myX = 1200, myY = 800; 
let myName = "ゲスト";
let myRoomId = null; 
let isMicMutedByUser = true; // 最初はミュート
let audioContext = null; 

// 背景画像の準備
const bgImage = new Image();
bgImage.src = "bg.jpg"; // 画像がない場合はpublicフォルダに入れてください

// ワールドサイズ (16:9)
const WORLD_W = 2000;
const WORLD_H = 1125;
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

// 会議室データ
const MEETING_ROOMS = [
    { id: 'A', name: '大会議室', type: 'rect', x: 50, y: 250, w: 650, h: 750, capacity: 8 }
];

// エリア定義
const ZONES = {
    SILENT: { 
        name: "集中ブース (会話禁止)", 
        check: (x, y) => x > 700 && y < 500,
        allowMic: false
    },
    MEETING_AREA: {
        name: "会議室エリア",
        check: (x, y) => x < 700,
        allowMic: true
    },
    LIVING: { 
        name: "コミュニティハブ (会話OK)", 
        check: (x, y) => true, // 上記以外はここ
        allowMic: true
    }
};

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const micBtn = document.getElementById('micBtn');

// ============================
// 1. セットアップ & 音声準備
// ============================
window.addEventListener('load', () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    if (isMobile) document.getElementById('d-pad').style.display = 'block';
});

// 「TAP TO START」
async function startSetup() {
    // 【重要】ユーザー操作の瞬間にAudioContextを作る
    unlockAudioContext();

    try {
        // マイク許可を取得
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop()); // 一旦止める
        
        // デバイス一覧取得
        await getDevices('micSelect', 'speakerSelect');
        
        document.getElementById('start-overlay').style.display = 'none';
        document.getElementById('entry-modal').style.display = 'flex';
        
        // マイクテスト開始
        document.getElementById('micSelect').addEventListener('change', startMicTest);
        startMicTest();
    } catch (err) {
        alert("マイクの使用を許可してください");
        console.error(err);
    }
}

// ブラウザのオーディオ制限を解除するおまじない
function unlockAudioContext() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioContext = new AC();
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    gain.gain.value = 0; // 無音
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
    
    // オーディオコンテキストが停止していたら再開
    if (audioContext && audioContext.state === 'suspended') {
        await audioContext.resume();
    }

    // 本番用マイクストリーム取得
    const micId = document.getElementById('micSelect').value;
    navigator.mediaDevices.getUserMedia({ 
        audio: { 
            deviceId: micId ? { exact: micId } : undefined,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        } 
    })
    .then(stream => {
        myStream = stream;
        setMicState(false); // 初期状態はミュート
        startConnection();
    })
    .catch(err => alert("マイク取得エラー: " + err));
});

function startConnection() {
    socket = io();
    
    socket.on('connect', () => { 
        myId = socket.id; 
    });

    socket.on('updateUsers', (data) => {
        users = data;
        connectToUsers(); // ユーザーリストが更新されたら接続チェック
    });

    myPeer = new Peer();
    
    myPeer.on('open', peerId => {
        // 自分のIDが決まったらサーバーへ入室通知
        socket.emit('enterRoom', { name: myName, peerId: peerId });
    });

    // ★相手から電話がかかってきた時の処理
    myPeer.on('call', call => {
        console.log("着信あり:", call.peer);
        call.answer(myStream); // 自分の音声を返す
        handleStream(call);
    });

    myPeer.on('error', err => console.error("PeerJS Error:", err));

    loop();
}

function loop() {
    draw();
    requestAnimationFrame(loop);
}

// ============================
// 音声接続ロジック (重要修正)
// ============================
function checkAudioStatus() {
    // 現在のエリア判定
    const currentZone = getCurrentZone();
    let canSpeak = false;

    if (myRoomId) {
        // 会議室: ボタン有効
        canSpeak = true;
        updateMicBtn(true, "会議中");
    } else {
        if (!currentZone.allowMic) {
            // 禁止エリア
            canSpeak = false;
            updateMicBtn(false, "会話禁止エリア");
        } else {
            // リビング
            canSpeak = true;
            updateMicBtn(true, "会話OK");
        }
    }

    // 物理マイクのON/OFF
    setMicState(canSpeak && !isMicMutedByUser);
    
    // 接続状態の更新
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

// ★誰と繋ぐかを判断して接続・切断する関数
function connectToUsers() {
    if (!myPeer || !myStream || !myId) return;

    const myZone = getCurrentZone();

    Object.keys(users).forEach(targetSocketId => {
        if (targetSocketId === myId) return; // 自分はスキップ
        
        const u = users[targetSocketId];
        if (!u.peerId) return; // 相手の音声IDがまだない

        // --- 接続すべき条件 ---
        let shouldConnect = false;

        if (myRoomId) {
            // 自分は会議室: 相手も「同じ会議室」ならOK
            if (u.roomId === myRoomId) shouldConnect = true;
        } else {
            // 自分は通常エリア
            if (!u.roomId) { // 相手も通常エリア
                // 相手のゾーン判定
                let uZoneIsSilent = ZONES.SILENT.check(u.x, u.y);
                
                // 自分も相手も「会話禁止エリア」でなければOK
                if (myZone.allowMic && !uZoneIsSilent) {
                    shouldConnect = true;
                }
            }
        }

        // --- 接続実行 ---
        if (shouldConnect) {
            // まだ繋がっていない場合のみ接続
            if (!peers[u.peerId]) {
                // ★重複接続防止: 「自分のPeerID > 相手のPeerID」の場合のみ発信
                // これにより、AとBが同時に発信して衝突するのを防ぐ
                if (myPeer.id > u.peerId) {
                    console.log("発信:", u.peerId);
                    const call = myPeer.call(u.peerId, myStream);
                    peers[u.peerId] = call; // SocketIDではなくPeerIDで管理
                    handleStream(call);
                }
            }
        } else {
            // 接続すべきでないのに繋がっていたら切る
            if (peers[u.peerId]) {
                console.log("切断:", u.peerId);
                peers[u.peerId].close();
                delete peers[u.peerId];
                removeAudio(u.peerId);
            }
        }
    });
}

function handleStream(call) {
    // 相手の音声ストリームが届いた時
    call.on('stream', remoteStream => {
        // 既に音声タグがあれば作らない
        if (document.getElementById("audio-" + call.peer)) return;

        console.log("音声受信開始:", call.peer);
        const audio = document.createElement('audio');
        audio.id = "audio-" + call.peer;
        audio.srcObject = remoteStream;
        audio.autoplay = true;
        audio.playsInline = true; // スマホ用
        
        // スピーカー出力先設定
        const spkId = document.getElementById('speakerSelectInGame').value;
        if(spkId && audio.setSinkId) audio.setSinkId(spkId).catch(e=>{});

        document.body.appendChild(audio);
    });

    call.on('close', () => {
        removeAudio(call.peer);
        delete peers[call.peer];
    });
    
    call.on('error', err => {
        console.error("Call Error:", err);
        removeAudio(call.peer);
        delete peers[call.peer];
    });
}

function removeAudio(peerId) {
    const el = document.getElementById("audio-" + peerId);
    if(el) el.remove();
}

// ============================
// 移動 & エリア判定
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
    checkAudioStatus(); // 移動するたびに音声接続チェック
}

function getCurrentZone() {
    if (ZONES.SILENT.check(myX, myY)) return ZONES.SILENT;
    if (ZONES.MEETING_AREA.check(myX, myY)) return ZONES.MEETING_AREA;
    return ZONES.LIVING;
}

// ============================
// 会議室システム
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
        
        // ★重要: 会議室に入ったら音声状態を即更新
        checkAudioStatus();
    };
}

function closeRoomModal() { document.getElementById('room-modal').style.display = 'none'; }

function leaveMeetingRoom() {
    myRoomId = null;
    // 退出先をソファエリア付近へ
    moveMe(1300, 800); 
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
        ctx.fillStyle = "#ccc"; ctx.fillRect(0, 0, WORLD_W, WORLD_H);
        ctx.fillStyle = "#000"; ctx.fillText("Loading BG...", 100, 100);
    }

    // 会議室エリアの枠線（薄く）
    MEETING_ROOMS.forEach(r => {
        ctx.strokeStyle = "rgba(52, 152, 219, 0.3)"; ctx.lineWidth = 2;
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.fillStyle = "rgba(0,0,0,0.5)"; ctx.font = "bold 20px sans-serif";
        ctx.fillText(r.name, r.x+20, r.y+40);
    });

    // ユーザー
    Object.keys(users).forEach(id => {
        const u = users[id];
        ctx.fillStyle = (id === myId) ? '#e74c3c' : '#3498db';
        ctx.shadowColor = "rgba(0,0,0,0.3)"; ctx.shadowBlur = 10;
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

// ============================
// ユーティリティ
// ============================
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
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const spkId = document.getElementById('speakerSelect').value;
    if (spkId && ctx.setSinkId) ctx.setSinkId(spkId).catch(e=>{});
    osc.connect(ctx.destination); osc.frequency.value = 523.25; osc.start(); osc.stop(ctx.currentTime + 0.3);
}
function startMicTest() {
    const micId = document.getElementById('micSelect').value; if(!micId) return;
    navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: micId } } }).then(s => {
        const AC = window.AudioContext || window.webkitAudioContext;
        const ctx = new AC(); const src = ctx.createMediaStreamSource(s);
        const anl = ctx.createAnalyser(); anl.fftSize = 256; src.connect(anl);
        const data = new Uint8Array(anl.frequencyBinCount);
        const bar = document.getElementById('mic-visualizer-bar');
        const upd = () => {
            if(document.getElementById('entry-modal').style.display==='none')return;
            anl.getByteFrequencyData(data); let sum=0; for(let i=0;i<data.length;i++)sum+=data[i];
            bar.style.width=Math.min(100,(sum/data.length)*3)+'%'; requestAnimationFrame(upd);
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