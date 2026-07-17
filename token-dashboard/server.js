/**
 * Claude Code トークン使用状況ダッシュボード — ローカルサーバー
 *
 * 依存パッケージなし(Node.js 18+ の標準モジュールのみ)。
 * データエンジンとして ccusage (https://github.com/ryoppippi/ccusage) を
 * 子プロセスで呼び出し、~/.claude/projects/ 配下の Claude Code ログを集計する。
 *
 * 起動:  node server.js   (または同梱の start.bat / start.sh)
 * URL :  http://localhost:4545
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { exec } = require("node:child_process");

const PORT = Number(process.env.PORT || 4545);
const PUBLIC_DIR = path.join(__dirname, "public");

// ccusage の呼び出しコマンド候補。グローバルインストール済みならそれを使い、
// なければ npx 経由(初回はダウンロードで数十秒かかることがある)。
// 環境変数 CCUSAGE_CMD で明示指定も可能。
const CCUSAGE_CANDIDATES = process.env.CCUSAGE_CMD
    ? [process.env.CCUSAGE_CMD]
    : ["ccusage", "npx -y ccusage"];
let resolvedCcusageCmd = null; // 一度成功したコマンドを記憶する

const EXEC_OPTS = {
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024, // 履歴が長いと JSON が大きくなるため余裕を持つ
    timeout: 120 * 1000,
};

function runCcusage(args) {
    const candidates = resolvedCcusageCmd ? [resolvedCcusageCmd] : CCUSAGE_CANDIDATES;
    return new Promise((resolve, reject) => {
        const tryNext = (i, lastErr) => {
            if (i >= candidates.length) {
                reject(lastErr || new Error("ccusage を実行できませんでした"));
                return;
            }
            const cmd = `${candidates[i]} ${args} --json`;
            exec(cmd, EXEC_OPTS, (err, stdout, stderr) => {
                if (err) {
                    tryNext(i + 1, new Error(`${cmd} が失敗しました: ${stderr || err.message}`));
                    return;
                }
                try {
                    resolvedCcusageCmd = candidates[i];
                    resolve(JSON.parse(stdout));
                } catch (e) {
                    tryNext(i + 1, new Error(`${cmd} の出力を JSON として解析できません: ${e.message}`));
                }
            });
        };
        tryNext(0, null);
    });
}

// 同一データの多重取得を防ぐ簡易キャッシュ(進行中の Promise も共有する)
const cache = new Map(); // key -> { promise, ts }
function cached(key, ttlMs, refresh, producer) {
    const hit = cache.get(key);
    if (!refresh && hit && Date.now() - hit.ts < ttlMs) return hit.promise;
    const entry = { promise: producer(), ts: Date.now() };
    cache.set(key, entry);
    entry.promise.catch(() => cache.delete(key)); // 失敗はキャッシュしない
    return entry.promise;
}

const API = {
    // 日次集計(全期間)。週次・月次はフロント側で日次から組み立てる。
    async usage(refresh) {
        const data = await cached("daily", 5 * 60 * 1000, refresh, () =>
            runCcusage("daily --order asc")
        );
        return { fetchedAt: new Date().toISOString(), ...data };
    },
    // 5時間課金ブロック(Max プランのレート制限枠と同じ区切り)
    async blocks(refresh) {
        const data = await cached("blocks", 60 * 1000, refresh, () =>
            runCcusage("blocks --recent")
        );
        return { fetchedAt: new Date().toISOString(), ...data };
    },
};

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
};

function sendJSON(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
    });
    res.end(body);
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const refresh = url.searchParams.get("refresh") === "1";

    if (url.pathname === "/api/usage" || url.pathname === "/api/blocks") {
        const handler = url.pathname === "/api/usage" ? API.usage : API.blocks;
        try {
            sendJSON(res, 200, await handler(refresh));
        } catch (e) {
            sendJSON(res, 500, { error: String(e.message || e) });
        }
        return;
    }

    // 静的ファイル配信(public 配下のみ)
    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    filePath = path.normalize(filePath).replace(/^([.][.][/\\])+/, "");
    const abs = path.join(PUBLIC_DIR, filePath);
    if (!abs.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
    }
    fs.readFile(abs, (err, buf) => {
        if (err) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Not Found");
            return;
        }
        res.writeHead(200, { "Content-Type": MIME[path.extname(abs)] || "application/octet-stream" });
        res.end(buf);
    });
});

server.listen(PORT, "127.0.0.1", () => {
    console.log("");
    console.log("  Claude Code トークンダッシュボード");
    console.log(`  → http://localhost:${PORT}`);
    console.log("");
    console.log("  初回はデータ集計(ccusage)に時間がかかることがあります。");
    console.log("  終了は Ctrl+C");
});
