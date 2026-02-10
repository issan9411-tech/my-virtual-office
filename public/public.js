// ページが完全に読み込まれてから実行
window.addEventListener('load', () => {
    const startBtn = document.getElementById('startBtn');
    const errorMsg = document.getElementById('error-msg');
    
    // ライブラリが正しく読み込まれたかチェック
    if (typeof io === 'undefined' || typeof Peer === 'undefined') {
        errorMsg.innerText = "エラー: ライブラリの読み込みに失敗しました。再読み込みしてください。";
        startBtn.disabled = true;
        return;
    }

    // ボタンにクリックイベントを設定
    startBtn.addEventListener('click', () => {
        initGame();
    });
});

// グローバル変数
let socket = null;
let myPeer = null;
let myStream = null;
let users = {};
let peers = {};
let myId = null;
let myX = 50, myY = 200;

// キャンバス設定
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const statusDiv = document.getElementById('status');

canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

// エリア定義
const ZONES = {
    WORK: { name: "作業エリア (静寂)", x: 0, w: 400, color: "#e0e0e0", mic: false },
    LIVING: { name: "リビング (会話)", x: 400, w: 400, color: "#b2fab4", mic: true },
    MEETING: { name: "会議室 (全員)", x: 800, w: 1200, color: "#b3cde0", mic: true }
};

// ゲーム開始処理
function initGame() {
    const startBtn = document.getElementById('startBtn');
    startBtn.innerText = "接続中...";
    startBtn.disabled = true;

    // マイクの取得を試みる
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert("エラー: このブラウザまたは環境（http）ではマイクが使えません。httpsでアクセスしてください。");
        startBtn.innerText = "入室失敗";
        return;
    }

    navigator.mediaDevices.getUserMedia({ video: false, audio: true })
        .then(stream => {
            myStream = stream;
            startConnection(); // マイクOKならサーバー接続へ
        })
        .catch(err => {
            console.error(err);
            alert("マイクの許可が必要です。\nブラウザの設定を確認してリロードしてください。");
            startBtn.innerText = "入室する";
            startBtn.disabled = false;
        });
}

// サーバー接続処理
function startConnection() {
    // Socket.io接続
    socket = io();

    socket.on('connect', () => {
        myId = socket.id;
        document.getElementById('overlay').style.display = 'none'; // オーバーレイを消す
        statusDiv.innerText = "接続完了！";
    });

    socket.on('updateUsers', (data) => {
        users = data;
        draw();
        connectToUsers();
    });

    // PeerJS接続
    myPeer = new Peer();
    
    myPeer.on('open', id => {
        if(socket) socket.emit('joinVoice', id);
    });

    myPeer.on('call', call => {
        call.answer(myStream);
        handleStream(call);
    });
    
    // エリアチェック開始
    checkZone();
}

function handleStream(call) {
    call.on('stream', userAudio => {
        if (document.getElementById(call.peer)) return;
        const audio = document.createElement('audio');
        audio.id = call.peer;
        audio.srcObject = userAudio;
        audio.play().catch(e => console.log("自動再生ブロック:", e));
    });
}

function connectToUsers() {
    if (!myPeer || !myStream) return;
    const myZone = getZone(myX);
    if (!myZone.mic) return; 

    Object.keys(users).forEach(id => {
        if (id === myId) return;
        const u = users[id];
        const userZone = getZone(u.x);
        
        if (u.peerId && userZone.mic && !peers[id]) {
            const call = myPeer.call(u.peerId, myStream);
            peers[id] = call;
            handleStream(call);
        }
    });
}

function getZone(x) {
    if (x < ZONES.WORK.x + ZONES.WORK.w) return ZONES.WORK;
    if (x < ZONES.LIVING.x + ZONES.LIVING.w) return ZONES.LIVING;
    return ZONES.MEETING;
}

// キー操作
document.addEventListener('keydown', e => {
    if(!socket) return;
    const step = 15;
    if (e.key === 'ArrowUp') myY -= step;
    if (e.key === 'ArrowDown') myY += step;
    if (e.key === 'ArrowLeft') myX -= step;
    if (e.key === 'ArrowRight') myX += step;
    socket.emit('move', { x: myX, y: myY });
    checkZone();
});

function checkZone() {
    if (!myStream) return;
    const zone = getZone(myX);
    
    // マイク切り替え
    const track = myStream.getAudioTracks()[0];
    if(track) track.enabled = zone.mic;
    
    statusDiv.innerText = `エリア: ${zone.name} | マイク: ${zone.mic ? 'ON' : 'OFF'}`;
}

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    [ZONES.WORK, ZONES.LIVING, ZONES.MEETING].forEach(z => {
        ctx.fillStyle = z.color;
        ctx.fillRect(z.x, 0, z.w, canvas.height);
        ctx.fillStyle = "#555";
        ctx.font = "20px Arial";
        ctx.fillText(z.name, z.x + 20, 50);
    });

    Object.keys(users).forEach(id => {
        const u = users[id];
        ctx.fillStyle = (id === myId) ? '#e74c3c' : '#3498db';
        ctx.beginPath();
        ctx.arc(u.x, u.y, 20, 0, Math.PI * 2);
        ctx.fill();
    });
}