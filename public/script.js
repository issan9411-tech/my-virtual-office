let socket = null, myPeer = null, myStream = null;
let users = {}, peers = {};
let myId = null, myX = 50, myY = 200;
let myName = "ゲスト";
let isMicMutedByUser = true;
let isDragging = false; // ドラッグ中かどうか

// スマホ判定
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const statusDiv = document.getElementById('status');
const micBtn = document.getElementById('micBtn');

canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

const ZONES = {
    WORK: { name: "作業 (無言)", x: 0, w: 400, color: "#e0e0e0", allowMic: false },
    LIVING: { name: "リビング (会話)", x: 400, w: 400, color: "#b2fab4", allowMic: true },
    MEETING: { name: "会議 (全員)", x: 800, w: 3000, color: "#b3cde0", allowMic: true }
};

window.addEventListener('load', async () => {
    // スマホならコントローラーを表示
    if (isMobile) {
        document.getElementById('d-pad').style.display = 'block';
    }
    await getDevices();
    document.getElementById('startBtn').addEventListener('click', initGame);
});

// デバイス取得（変更なし）
async function getDevices() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
        const devices = await navigator.mediaDevices.enumerateDevices();
        const micSelect = document.getElementById('micSelect');
        const spkSelect = document.getElementById('speakerSelect');
        micSelect.innerHTML = ''; spkSelect.innerHTML = '';
        devices.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.text = d.label || d.kind;
            if (d.kind === 'audioinput') micSelect.appendChild(opt);
            if (d.kind === 'audiooutput') spkSelect.appendChild(opt);
        });
    } catch(e) { console.error(e); }
}

function initGame() {
    const nameInput = document.getElementById('username');
    if (!nameInput.value) { alert("名前を入力してください"); return; }
    myName = nameInput.value;

    const startBtn = document.getElementById('startBtn');
    startBtn.disabled = true;
    startBtn.innerText = "接続中...";

    const micId = document.getElementById('micSelect').value;
    navigator.mediaDevices.getUserMedia({ audio: { deviceId: micId ? { exact: micId } : undefined } })
        .then(stream => {
            myStream = stream;
            setMicState(false);
            startConnection();
        })
        .catch(err => {
            alert("マイクエラー: " + err);
            startBtn.disabled = false;
        });
}

function startConnection() {
    socket = io();
    socket.on('connect', () => {
        myId = socket.id;
        document.getElementById('overlay').style.display = 'none';
        statusDiv.innerText = "接続完了";
    });

    socket.on('updateUsers', (data) => {
        users = data;
        draw();
        connectToUsers();
    });

    myPeer = new Peer();
    myPeer.on('open', id => {
        // 名前とPeerIDをサーバーへ送る
        socket.emit('enterRoom', { name: myName, peerId: id });
    });

    myPeer.on('call', call => {
        call.answer(myStream);
        handleStream(call);
    });

    checkZone();
    draw();
}

// ----------------------
// マウス・タッチ操作の実装
// ----------------------

// 1. ダブルクリックで瞬間移動
canvas.addEventListener('dblclick', (e) => {
    moveMe(e.clientX, e.clientY);
});

// 2. ドラッグ＆ドロップ移動 (PC)
canvas.addEventListener('mousedown', (e) => {
    // 自分のアバターをクリックしたか判定 (半径30px以内)
    const dist = Math.sqrt((e.clientX - myX)**2 + (e.clientY - myY)**2);
    if (dist < 30) isDragging = true;
});

canvas.addEventListener('mousemove', (e) => {
    if (isDragging) {
        moveMe(e.clientX, e.clientY);
    }
});

canvas.addEventListener('mouseup', () => { isDragging = false; });

// 3. スマホ用コントローラー (タッチイベント)
const speed = 15;
const setupBtn = (id, dx, dy) => {
    const btn = document.getElementById(id);
    let interval;
    btn.addEventListener('touchstart', (e) => {
        e.preventDefault(); // スクロール防止
        interval = setInterval(() => {
            moveMe(myX + dx, myY + dy);
        }, 50);
    });
    btn.addEventListener('touchend', () => clearInterval(interval));
};

setupBtn('d-up', 0, -speed);
setupBtn('d-down', 0, speed);
setupBtn('d-left', -speed, 0);
setupBtn('d-right', speed, 0);


// 移動共通処理
function moveMe(x, y) {
    if (!socket) return;
    myX = x;
    myY = y;
    socket.emit('move', { x: myX, y: myY });
    checkZone();
    draw();
}


// ----------------------
// その他ロジック (前回同様)
// ----------------------
function checkZone() {
    const zone = getZone(myX);
    if (!zone.allowMic) {
        micBtn.disabled = true;
        micBtn.innerText = "🚫 会話禁止";
        micBtn.style.background = "#555";
        setMicState(false);
    } else {
        micBtn.disabled = false;
        updateMicBtnDesign();
        setMicState(!isMicMutedByUser);
    }
    statusDiv.innerText = `場所: ${zone.name}`;
}

function setMicState(isOn) {
    if (myStream) myStream.getAudioTracks()[0].enabled = isOn;
}

function toggleMic() {
    isMicMutedByUser = !isMicMutedByUser;
    updateMicBtnDesign();
    checkZone(); // 再適用
}

function updateMicBtnDesign() {
    if (isMicMutedByUser) {
        micBtn.innerText = "マイクOFF";
        micBtn.style.background = "#e74c3c";
    } else {
        micBtn.innerText = "マイクON 🎙️";
        micBtn.style.background = "#4CAF50";
    }
}

function getZone(x) {
    if (x < ZONES.WORK.x + ZONES.WORK.w) return ZONES.WORK;
    if (x < ZONES.LIVING.x + ZONES.LIVING.w) return ZONES.LIVING;
    return ZONES.MEETING;
}

// 設定画面
function openSettings() { document.getElementById('settings-modal').style.display = 'block'; }
function closeSettings() { 
    document.getElementById('settings-modal').style.display = 'none';
    const spkId = document.getElementById('speakerSelect').value;
    document.querySelectorAll('audio').forEach(a => {
        if(a.setSinkId) a.setSinkId(spkId).catch(e=>console.log(e));
    });
}

function handleStream(call) {
    call.on('stream', userAudio => {
        if (document.getElementById(call.peer)) return;
        const audio = document.createElement('audio');
        audio.id = call.peer;
        audio.srcObject = userAudio;
        const spkId = document.getElementById('speakerSelect').value;
        if(spkId && audio.setSinkId) audio.setSinkId(spkId);
        audio.play().catch(e=>console.log(e));
        document.body.appendChild(audio);
    });
    call.on('close', () => {
        const el = document.getElementById(call.peer);
        if(el) el.remove();
    });
}

function connectToUsers() {
    if (!myPeer || !myStream) return;
    const myZone = getZone(myX);
    if (!myZone.allowMic) return;

    Object.keys(users).forEach(id => {
        if (id === myId) return;
        const u = users[id];
        const userZone = getZone(u.x);
        if (u.peerId && userZone.allowMic && !peers[id]) {
            const call = myPeer.call(u.peerId, myStream);
            peers[id] = call;
            handleStream(call);
        }
    });
}

// PC矢印キーも残す
document.addEventListener('keydown', e => {
    const s = 15;
    if (e.key === 'ArrowUp') moveMe(myX, myY - s);
    if (e.key === 'ArrowDown') moveMe(myX, myY + s);
    if (e.key === 'ArrowLeft') moveMe(myX - s, myY);
    if (e.key === 'ArrowRight') moveMe(myX + s, myY);
});

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    [ZONES.WORK, ZONES.LIVING, ZONES.MEETING].forEach(z => {
        ctx.fillStyle = z.color;
        ctx.fillRect(z.x, 0, z.w, canvas.height);
        ctx.fillStyle = "#555";
        ctx.font = "bold 20px sans-serif";
        ctx.fillText(z.name, z.x + 20, 50);
    });

    Object.keys(users).forEach(id => {
        const u = users[id];
        // 本体
        ctx.fillStyle = (id === myId) ? '#e74c3c' : '#3498db';
        ctx.beginPath();
        ctx.arc(u.x, u.y, 20, 0, Math.PI * 2);
        ctx.fill();
        
        // 名前表示
        ctx.fillStyle = "black";
        ctx.font = "bold 14px sans-serif";
        ctx.textAlign = "center";
        // 名前がない場合は "..." と表示
        ctx.fillText(u.name || "...", u.x, u.y - 30);
    });
}