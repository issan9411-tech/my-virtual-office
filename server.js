const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, {
    cors: {
        origin: "*", // どのURLからの接続も許可する（エラー防止）
        methods: ["GET", "POST"]
    }
});

// ---------------------------------------------------
// ▼ ここが修正ポイント（ファイルの読み込み設定）
// ---------------------------------------------------

// 1. まず「public」フォルダの中を探す（基本設定）
app.use(express.static("public"));

// 2. もし無ければ「今のフォルダ（ルート）」も探す（エラー回避の裏技）
// これにより、script.jsをどこに置いてしまっても読み込めるようになります
app.use(express.static(__dirname));

// ---------------------------------------------------
// ▼ 通信ロジック
// ---------------------------------------------------

let users = {};

io.on("connection", (socket) => {
    console.log("ユーザー接続:", socket.id);

    // 初期位置 (X=50, Y=200)
    users[socket.id] = { x: 50, y: 200, peerId: null };

    // 全員に最新のユーザー情報を送る
    io.emit("updateUsers", users);

    // 音声ID（PeerID）を受け取った時
    socket.on("joinVoice", (peerId) => {
        if (users[socket.id]) {
            users[socket.id].peerId = peerId;
            io.emit("updateUsers", users); // 更新を全員に通知
        }
    });

    // 移動情報を受け取った時
    socket.on("move", (data) => {
        if (users[socket.id]) {
            users[socket.id].x = data.x;
            users[socket.id].y = data.y;
            io.emit("updateUsers", users);
        }
    });

    // 切断時
    socket.on("disconnect", () => {
        console.log("ユーザー切断:", socket.id);
        delete users[socket.id];
        io.emit("updateUsers", users);
    });
});

// ---------------------------------------------------
// ▼ サーバー起動
// ---------------------------------------------------

// Renderなどのクラウド環境では process.env.PORT が自動で使われます
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});