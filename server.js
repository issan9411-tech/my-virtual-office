const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, {
    cors: { origin: "*" } // 通信許可設定
});

app.use(express.static("public"));

let users = {};

io.on("connection", (socket) => {
    console.log("User connected:", socket.id);
    
    // 初期位置
    users[socket.id] = { x: 50, y: 200, peerId: null };
    io.emit("updateUsers", users);

    socket.on("joinVoice", (peerId) => {
        if (users[socket.id]) {
            users[socket.id].peerId = peerId;
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

// Renderは環境変数 PORT を自動で割り当てます
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});