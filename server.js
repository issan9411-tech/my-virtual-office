const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static("public"));
app.use(express.static(__dirname));

let users = {};

io.on("connection", (socket) => {
    console.log("ユーザー接続:", socket.id);

    // 初期データ（名前はまだ不明）
    users[socket.id] = { x: 50, y: 200, peerId: null, name: "ゲスト" };

    io.emit("updateUsers", users);

    // 入室時に名前とPeerIDをセット
    socket.on("enterRoom", (data) => {
        if (users[socket.id]) {
            users[socket.id].name = data.name || "名無し";
            users[socket.id].peerId = data.peerId;
            io.emit("updateUsers", users);
        }
    });

    socket.on("move", (data) => {
        if (users[socket.id]) {
            users[socket.id].x = data.x;
            users[socket.id].y = data.y;
            io.emit("updateUsers", users);
        }
    });

    socket.on("disconnect", () => {
        delete users[socket.id];
        io.emit("updateUsers", users);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});