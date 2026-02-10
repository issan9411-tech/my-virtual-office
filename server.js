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
    // 初期データ
    // roomId: null (通常エリア), 'roomA', 'roomB' (会議室)
    users[socket.id] = { x: 100, y: 300, peerId: null, name: "ゲスト", roomId: null };

    io.emit("updateUsers", users);

    socket.on("enterRoom", (data) => {
        if (users[socket.id]) {
            users[socket.id].name = data.name || "名無し";
            users[socket.id].peerId = data.peerId;
            io.emit("updateUsers", users);
        }
    });

    // 移動と部屋情報の更新
    socket.on("move", (data) => {
        if (users[socket.id]) {
            users[socket.id].x = data.x;
            users[socket.id].y = data.y;
            users[socket.id].roomId = data.roomId; // 部屋情報を保存
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