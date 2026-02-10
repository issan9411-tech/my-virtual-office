// ページ読み込み完了後に実行
window.addEventListener('load', () => {
    const startBtn = document.getElementById('startBtn');
    const errorMsg = document.getElementById('error-msg');

    // 1. ライブラリが正しく読み込まれているかチェック
    if (typeof io === 'undefined' || typeof Peer === 'undefined') {
        if (errorMsg) errorMsg.innerText = "エラー: 必要なライブラリ(Socket.io / PeerJS)が読み込まれていません。";
        if (startBtn) startBtn.disabled = true;
        return;
    }

    // 2. ボタンクリックで開始
    if (startBtn) {
        startBtn.addEventListener('click', () => {
            initGame();
        });
    }
});

// グローバル変数
let socket = null;
let myPeer = null;
let myStream = null;
let users = {};
let peers = {}; // 通話オブジェクト管理
let myId = null;
let myX = 50;
let myY = 200;

// キャンバス設定
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const statusDiv = document.getElementById('status');

// 画面サイズ調整
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

// エリア定義
const ZONES = {
    WORK: { name: "作業エリア (静寂)", x: 0, w: 400, color: "#e0e0e0", mic: false },
    LIVING: { name: "リビング (会話)", x: 400, w: 400, color: "#b2fab4", mic: true },
    MEETING: { name: "会議室 (全員)", x: 800, w: 2000, color: "#b3cde0", mic: true }
};

// ゲーム初期化（マイク取得）
function initGame() {
    const startBtn = document.getElementById('startBtn');
    startBtn.innerText = "起動中...";
    startBtn.disabled = true;

    // マイク権限の確認
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert("このブラウザではマイクが使えません。(HTTPS接続が必要です)");
        startBtn.innerText = "エラー";
        return;
    }

    navigator.mediaDevices.getUserMedia({ video: false, audio: true })
        .then(stream => {
            myStream = stream;
            startConnection(); // マイクOKならサーバーへ接続
        })
        .catch(err => {
            console.error("マイク取得エラー:", err);
            alert("マイクの使用が許可されませんでした。ブラウザの設定を確認してください。");
            startBtn.innerText = "入室する";
            startBtn.disabled = false;
        });
}

// サーバー接続開始
function startConnection() {
    // Socket.io 接続
    socket = io();

    socket.on('connect', () => {
        myId = socket.id;
        document.getElementById('overlay').style.display = 'none'; // 入室ボタンを消す
        statusDiv.innerText = "接続完了";
    });

    // 他ユーザー情報の更新
    socket.on('updateUsers', (data) => {
        users = data;
        draw();
        connectToUsers(); // エリア状況を見て音声をつなぐ
    });

    // PeerJS (音声) 接続
    myPeer = new Peer();

    myPeer.on('open', id => {
        // 自分の音声IDをサーバーに伝える
        if (socket) socket.emit('joinVoice', id);
    });

    // 誰かから着信があった場合
    myPeer.on('call', call => {
        call.answer(myStream); // 自分の音声を送り返す
        handleStream(call);
    });

    // 初期描画とエリア判定
    checkZone();
    draw();
}

// 相手の音声ストリームを処理
function handleStream(call) {
    call.on('stream', userAudio => {
        // すでに音声タグがある場合は作成しない
        if (document.getElementById(call.peer)) return;

        const audio = document.createElement('audio');
        audio.id = call.peer; // IDをつけて管理
        audio.srcObject = userAudio;
        
        // 自動再生 (ブラウザの制限対策)
        audio.play().catch(e => console.log("自動再生ブロック:", e));
        
        document.body.appendChild(audio);
    });
    
    // 切断時の処理
    call.on('close', () => {
        const audio = document.getElementById(call.peer);
        if (audio) audio.remove();
    });
}

// 自分から接続しにいくロジック
function connectToUsers() {
    if (!myPeer || !myStream) return;

    const myZone = getZone(myX);
    // 自分が「会話NG」エリアにいるなら何もしない
    if (!myZone.mic) return;

    Object.keys(users).forEach(id => {
        if (id === myId) return; // 自分は除外
        const u = users[id];
        const userZone = getZone(u.x);

        // 相手も「会話OK」エリアにいて、音声IDがあり、まだ繋がっていない場合
        if (u.peerId && userZone.mic && !peers[id]) {
            console.log(`接続開始: ${id}`);
            const call = myPeer.call(u.peerId, myStream);
            peers[id] = call;
            handleStream(call);
        }
    });
}

// 座標から現在のエリアを取得
function getZone(x) {
    if (x < ZONES.WORK.x + ZONES.WORK.w) return ZONES.WORK;
    if (x < ZONES.LIVING.x + ZONES.LIVING.w) return ZONES.LIVING;
    return ZONES.MEETING;
}

// キーボード操作
document.addEventListener('keydown', e => {
    if (!socket) return; // 接続前は動けない

    const step = 15;
    if (e.key === 'ArrowUp') myY -= step;
    if (e.key === 'ArrowDown') myY += step;
    if (e.key === 'ArrowLeft') myX -= step;
    if (e.key === 'ArrowRight') myX += step;

    // サーバーへ位置送信
    socket.emit('move', { x: myX, y: myY });
    
    checkZone();
    draw();
});

// エリアチェックとマイクミュート制御
function checkZone() {
    if (!myStream) return;
    const zone = getZone(myX);

    // マイクのON/OFF切り替え
    const audioTrack = myStream.getAudioTracks()[0];
    if (audioTrack) {
        audioTrack.enabled = zone.mic;
    }

    statusDiv.innerText = `エリア: ${zone.name} | マイク: ${zone.mic ? 'ON' : 'OFF'}`;
}

// 描画ループ
function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 1. エリア（背景）を描画
    [ZONES.WORK, ZONES.LIVING, ZONES.MEETING].forEach(z => {
        ctx.fillStyle = z.color;
        ctx.fillRect(z.x, 0, z.w, canvas.height);
        
        ctx.fillStyle = "#555";
        ctx.font = "bold 20px sans-serif";
        ctx.fillText(z.name, z.x + 20, 50);
    });

    // 2. ユーザー（アバター）を描画
    Object.keys(users).forEach(id => {
        const u = users[id];
        
        // 自分は赤、他人は青
        ctx.fillStyle = (id === myId) ? '#e74c3c' : '#3498db';
        
        ctx.beginPath();
        ctx.arc(u.x, u.y, 20, 0, Math.PI * 2);
        ctx.fill();

        // ID表示（デバッグ用）
        ctx.fillStyle = "black";
        ctx.font = "12px sans-serif";
        ctx.fillText(id.substring(0, 4), u.x - 10, u.y - 25);
    });
}