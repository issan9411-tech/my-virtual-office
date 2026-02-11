// ============================
// グローバル変数 & 設定
// ============================
let socket = null, myPeer = null, myStream = null;
let users = {};
let myId = null;

// ★接続管理用: アクティブな通話オブジェクトをPeerIDで管理
let activeCalls = {}; 

// 初期位置
let myX = 1400, myY = 900; 
let myName = "ゲスト";
let myRoomId = null; 
let isMicMutedByUser = true;
let audioContext = null; 
let currentSpeakerId = "";

// ズーム設定
let cameraScale = 1.0;
const MIN_ZOOM = 0.4; 
const MAX_ZOOM = 2.0; 

// 背景画像
const bgImage = new Image();
bgImage.src = "bg.jpg"; 

// BGM設定
const bgmAudio = new Audio();
bgmAudio.loop = true; 
bgmAudio.volume = 0.3;

let timerInterval = null;
let timerTime = 15 * 60;
let isFocusMode = true; 
let isTimerRunning = false;

const WORLD_W = 2000;
const WORLD_H = 1125;
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

// 距離設定
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
// ライフサイクル & イベント
// ============================
window.addEventListener('load', () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    if (isMobile) document.getElementById('d-pad').style.display = 'block';
    
    document.getElementById('bgmSelect').addEventListener('change', changeBgm);
    
    const volSlider = document.getElementById('bgmVolume');
    volSlider.addEventListener('input', (e) => {
        bgmAudio.volume = parseFloat(e.target.value);
    });
    bgmAudio.volume = parseFloat(volSlider.value);

    // ★タブがアクティブになった時にオーディオを復帰させる
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            ensureAudioContext();
        }
    });
    
    // ★画面クリック時もオーディオ復帰
    document.body.addEventListener('click', ensureAudioContext, { once: false });
    document.body.addEventListener('touchstart', ensureAudioContext, { once: false });
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

// オーディオコンテキストの確実な起動・再開
function ensureAudioContext() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    
    if (!audioContext) {
        audioContext = new AC();
    }
    
    if (audioContext.state === 'suspended') {
        audioContext.resume().then(() => {
            console.log("AudioContext resumed");
        }).catch(e => console.error(e));
    }
}

// 初期セットアップ
async function startSetup() {
    ensureAudioContext();
    try {
        // マイク許可取得（ストリームはすぐ捨てる）
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
        
        await getDevices('micSelect', 'speakerSelect');
        document.getElementById('start-overlay').style.display = 'none';
        document.getElementById('entry-modal').style.display = 'flex';
        
        const micSelect = document.getElementById('micSelect');
        micSelect.addEventListener('change', () => startMicTest('micSelect', 'mic-visualizer-bar-entry'));
        startMicTest('micSelect', 'mic-visualizer-bar-entry');
    } catch (err) { 
        alert("マイクの使用を許可してください。"); 
    }
}

// ============================
// 入室・接続開始
// ============================
document.getElementById('enterGameBtn').addEventListener('click', async () => {
    const nameInput = document.getElementById('username');
    if (!nameInput.value) { alert("名前を入力してください"); return; }
    myName = nameInput.value;
    
    document.getElementById('entry-modal').style.display = 'none';
    ensureAudioContext();

    const micId = document.getElementById('micSelect').value;
    currentSpeakerId = document.getElementById('speakerSelect').value;

    // マイク取得設定 (軽量化設定)
    const constraints = { 
        audio: { 
            deviceId: micId ? { exact: micId } : undefined, 
            echoCancellation: true, 
            noiseSuppression: true, 
            autoGainControl: true, 
            channelCount: 1, // モノラル
            sampleRate: 16000 // サンプルレート低減
        } 
    };

    navigator.mediaDevices.getUserMedia(constraints)
    .then(stream => {
        myStream = stream;
        setMicState(false); // 初期ミュート
        startSocketConnection();
    })
    .catch(err => alert("マイクエラー: " + err));
});

function startSocketConnection() {
    socket = io();
    
    socket.on('connect', () => { myId = socket.id; });
    
    socket.on('updateUsers', (data) => { 
        users = data; 
        // ユーザー更新時は音量調整だけ行う（接続処理は定期実行に任せる）
        updateVolumes(); 
    });
    
    myPeer = new Peer();
    
    myPeer.on('open', peerId => {
        socket.emit('enterRoom', { name: myName, peerId: peerId });
    });
    
    // ★着信処理の強化
    myPeer.on('call', call => {
        console.log("着信:", call.peer);
        // こちらのストリームを返して応答
        call.answer(myStream);
        setupCallEvents(call);
        // 管理リストに追加
        activeCalls[call.peer] = call;
    });

    myPeer.on('error', err => console.error("PeerJS Error:", err));

    // ★接続監視ループ (1秒ごとに実行)
    setInterval(manageConnections, 1000);
    // 音量監視ループ (0.5秒ごとに実行)
    setInterval(updateVolumes, 500);
    
    loop();
}

function loop() { draw(); requestAnimationFrame(loop); }

// ============================
// ★接続管理ロジック (最重要)
// ============================
function manageConnections() {
    if (!myPeer || !myStream || !myId) return;
    
    const myZone = getCurrentZone();

    // 1. 各ユーザーについて「繋ぐべきか」「切るべきか」を判定
    Object.keys(users).forEach(targetId => {
        if (targetId === myId) return;
        const u = users[targetId];
        if (!u.peerId) return; // 相手のPeerIDがまだない

        let shouldConnect = false;

        // --- 接続条件の判定 ---
        if (myRoomId) {
            // 会議室: 同じ部屋なら接続
            if (u.roomId === myRoomId) shouldConnect = true;
        } else {
            // リビング: お互い部屋なし
            if (!u.roomId) {
                const dist = Math.sqrt((myX - u.x)**2 + (myY - u.y)**2);
                const uZoneIsSilent = ZONES.SILENT.check(u.x, u.y);
                
                // 禁止エリア外 かつ 距離判定
                if (myZone.allowMic && !uZoneIsSilent) {
                    if (dist <= TALK_DISTANCE) {
                        shouldConnect = true; // 接続圏内
                    } else if (dist <= DISCONNECT_DISTANCE && activeCalls[u.peerId]) {
                        shouldConnect = true; // 切断マージン内なら維持
                    }
                }
            }
        }

        // --- アクション実行 ---
        if (shouldConnect) {
            // まだ繋がっていない場合のみ発信
            if (!activeCalls[u.peerId]) {
                // 重複発信防止: PeerIDの文字列比較で「大きい方」から「小さい方」へかける
                if (myPeer.id > u.peerId) {
                    console.log("発信開始:", u.name);
                    const call = myPeer.call(u.peerId, myStream);
                    setupCallEvents(call);
                    activeCalls[u.peerId] = call;
                }
            }
        } else {
            // 繋ぐべきでないのに繋がっている場合は切断
            if (activeCalls[u.peerId]) {
                console.log("切断:", u.name);
                activeCalls[u.peerId].close();
                delete activeCalls[u.peerId];
                removeAudio(u.peerId);
            }
        }
    });

    // 2. 存在しないユーザーの接続が残っていたら掃除
    Object.keys(activeCalls).forEach(peerId => {
        const isUserExists = Object.values(users).some(u => u.peerId === peerId);
        if (!isUserExists) {
            activeCalls[peerId].close();
            delete activeCalls[peerId];
            removeAudio(peerId);
        }
    });
}

// 通話イベントのセットアップ（発信・着信共通）
function setupCallEvents(call) {
    call.on('stream', remoteStream => {
        // 既に音声タグがある場合は作らない
        if (document.getElementById("audio-" + call.peer)) return;
        
        const audio = document.createElement('audio');
        audio.id = "audio-" + call.peer;
        audio.srcObject = remoteStream;
        audio.autoplay = true; 
        audio.playsInline = true; // iOS必須
        
        if(currentSpeakerId && audio.setSinkId) audio.setSinkId(currentSpeakerId).catch(e=>{});
        
        // 初期状態は音量0（updateVolumesで距離に応じて上げる）
        audio.volume = 0; 
        audio.muted = true; 
        
        document.body.appendChild(audio);
        console.log("音声受信開始:", call.peer);
    });

    // 切断・エラー時のクリーンアップ
    const cleanup = () => {
        removeAudio(call.peer);
        if (activeCalls[call.peer]) delete activeCalls[call.peer];
    };
    
    call.on('close', cleanup);
    call.on('error', (e) => {
        console.error("通話エラー:", e);
        cleanup();
    });
}

function removeAudio(peerId) {
    const el = document.getElementById("audio-" + peerId);
    if(el) el.remove();
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
            // 会議室: 100%
            if (u.roomId === myRoomId) volume = 1.0;
        } else {
            // リビング
            if (!u.roomId) {
                const dist = Math.sqrt((myX - u.x)**2 + (myY - u.y)**2);
                if (dist <= TALK_DISTANCE) volume = 1.0;
                else volume = 0;
            }
        }

        // スマホ対策: volumeだけでなくmutedプロパティも操作
        if (volume <= 0.01) {
            audioEl.muted = true;
        } else {
            audioEl.muted = false;
            audioEl.volume = volume;
        }
    });
}

// ============================
// 移動・エリア・マイク制御
// ============================
canvas.addEventListener('click', (e) => {
    if (myRoomId) return;
    const pos = getWorldPos(e.clientX, e.clientY);
    const room = MEETING_ROOMS.find(r => pos.x >= r.x && pos.x <= r.x+r.w && pos.y >= r.y && pos.y <= r.y+r.h);
    if (room) showRoomModal(room);
});

canvas.addEventListener('dblclick', (e) => {
    if (myRoomId) return;
    const pos = getWorldPos(e.clientX, e.clientY);
    const room = MEETING_ROOMS.find(r => pos.x >= r.x && pos.x <= r.x+r.w && pos.y >= r.y && pos.y <= r.y+r.h);
    if (!room) moveMe(pos.x, pos.y);
});

window.addEventListener('keydown', (e) => {
    if (myRoomId || document.activeElement.tagName === 'INPUT') return;
    const speed = 20; 
    let nextX = myX, nextY = myY, moved = false;
    switch(e.key) {
        case 'ArrowUp': nextY -= speed; moved = true; break;
        case 'ArrowDown': nextY += speed; moved = true; break;
        case 'ArrowLeft': nextX -= speed; moved = true; break;
        case 'ArrowRight': nextX += speed; moved = true; break;
    }
    if (moved) { e.preventDefault(); moveMe(nextX, nextY); }
});

let lastMoveTime = 0;
function moveMe(x, y) {
    myX = Math.max(20, Math.min(x, WORLD_W-20));
    myY = Math.max(20, Math.min(y, WORLD_H-20));
    
    const now = Date.now();
    if (socket && (now - lastMoveTime > 50)) {
        socket.emit('move', { x: myX, y: myY, roomId: myRoomId });
        lastMoveTime = now;
    }
    checkAudioStatus(); // ボタン表示更新のため
}

function getCurrentZone() {
    if (ZONES.SILENT.check(myX, myY)) return ZONES.SILENT;
    return ZONES.LIVING;
}

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
    // 物理マイクのON/OFF切り替え
    setMicState(canSpeak && !isMicMutedByUser);
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

function toggleMic() { 
    isMicMutedByUser = !isMicMutedByUser; 
    checkAudioStatus(); 
}

function setMicState(isOn) { 
    if (myStream && myStream.getAudioTracks()[0]) {
        myStream.getAudioTracks()[0].enabled = isOn; 
    }
}

function exitOffice() { if(confirm("退出しますか？")) location.reload(); }

// ============================
// 会議室ロジック
// ============================
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
        ensureAudioContext();
        myRoomId = room.id;
        myX = room.x + room.w/2 - 50 + Math.random()*100;
        myY = room.y + room.h/2 - 50 + Math.random()*100;
        socket.emit('move', { x: myX, y: myY, roomId: myRoomId });
        
        document.getElementById('room-modal').style.display = 'none';
        document.getElementById('leaveRoomBtn').style.display = 'block';
        document.getElementById('room-status').style.display = 'block';
        
        // 入室時はマイク有効化
        if(myStream) myStream.getAudioTracks().forEach(t => t.enabled = true);
        checkAudioStatus();
        manageConnections(); // 即座に接続更新
    };
}

function closeRoomModal() { document.getElementById('room-modal').style.display = 'none'; }

function leaveMeetingRoom() {
    myRoomId = null;
    moveMe(1300, 900);
    document.getElementById('leaveRoomBtn').style.display = 'none';
    document.getElementById('room-status').style.display = 'none';
    checkAudioStatus();
    manageConnections();
}

// ============================
// ポモドーロタイマー & BGM
// ============================
function openTimer() { document.getElementById('timer-modal').style.display = 'flex'; }
function closeTimer() { document.getElementById('timer-modal').style.display = 'none'; }

function toggleTimer() {
    const btn = document.getElementById('timerStartBtn');
    if (isTimerRunning) {
        clearInterval(timerInterval);
        isTimerRunning = false;
        bgmAudio.pause();
        btn.innerText = "再開"; btn.className = "btn btn-green";
    } else {
        timerInterval = setInterval(updateTimer, 1000);
        isTimerRunning = true;
        playCurrentBgm();
        btn.innerText = "一時停止"; btn.className = "btn btn-orange";
    }
}

function resetTimer() {
    clearInterval(timerInterval);
    isTimerRunning = false;
    isFocusMode = true;
    timerTime = 15 * 60;
    bgmAudio.pause(); bgmAudio.currentTime = 0;
    
    updateTimerDisplay();
    document.getElementById('timerStartBtn').innerText = "スタート";
    document.getElementById('timerStartBtn').className = "btn btn-green";
    document.getElementById('timer-status-text').innerText = "集中タイム (15分)";
    document.getElementById('timer-status-text').style.color = "#e67e22";
}

function updateTimer() {
    timerTime--;
    if (timerTime < 0) switchMode();
    updateTimerDisplay();
}

function switchMode() {
    isFocusMode = !isFocusMode;
    if (isFocusMode) {
        timerTime = 15 * 60; 
        document.getElementById('timer-status-text').innerText = "集中タイム (15分)";
        document.getElementById('timer-status-text').style.color = "#e67e22";
    } else {
        timerTime = 5 * 60; 
        document.getElementById('timer-status-text').innerText = "休憩タイム (5分)";
        document.getElementById('timer-status-text').style.color = "#27ae60";
    }
    playCurrentBgm();
}

function updateTimerDisplay() {
    const m = Math.floor(timerTime / 60).toString().padStart(2, '0');
    const s = (timerTime % 60).toString().padStart(2, '0');
    document.getElementById('timer-display').innerText = `${m}:${s}`;
}

function changeBgm() { if (isTimerRunning) playCurrentBgm(); }

function playCurrentBgm() {
    let src = "";
    if (!isFocusMode) src = "bgm_break.mp3";
    else {
        const val = document.getElementById('bgmSelect').value;
        if (val === "focus1") src = "bgm_focus1.mp3";
        else if (val === "focus2") src = "bgm_focus2.mp3";
        else if (val === "focus3") src = "bgm_focus3.mp3";
        else src = "";
    }

    if (src) {
        if (!bgmAudio.src.includes(src)) {
            bgmAudio.src = src;
            bgmAudio.load();
        }
        if(currentSpeakerId && bgmAudio.setSinkId) bgmAudio.setSinkId(currentSpeakerId).catch(e=>{});
        bgmAudio.play().catch(e=>{});
    } else {
        bgmAudio.pause();
    }
}

// ============================
// 設定・デバイス関連
// ============================
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
        if (currentSpeakerId) speakerSelect.value = currentSpeakerId;
        
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
            
            // 既存の通話のストリームを置換
            Object.values(activeCalls).forEach(call => {
                const sender = call.peerConnection.getSenders().find(s => s.track.kind === 'audio');
                if (sender) sender.replaceTrack(newStream.getAudioTracks()[0]);
            });
            alert("設定を適用しました");
        } catch (e) { alert("失敗: " + e); }
    }
    if (spkId) {
        currentSpeakerId = spkId;
        document.querySelectorAll('audio').forEach(a => {
            if (a.setSinkId) a.setSinkId(spkId).catch(e=>{});
        });
        if(bgmAudio.setSinkId) bgmAudio.setSinkId(spkId).catch(e=>{});
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

    if (bgImage.complete) ctx.drawImage(bgImage, 0, 0, WORLD_W, WORLD_H);
    else { ctx.fillStyle = "#eee"; ctx.fillRect(0, 0, WORLD_W, WORLD_H); }

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
        ctx.fillStyle = "rgba(46, 204, 113, 0.1)"; ctx.fill();
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