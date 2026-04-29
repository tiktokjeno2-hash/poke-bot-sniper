const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const HISTORY_FILE = 'history.json';
const MAX_MEMORY = 500; 
const BASE_URL = "https://shiny.com"; 

// ==========================================
// 🎯 ตั้งค่าเป้าหมายทั้งหมด (Multi-Target Radar)
// ==========================================
const TARGET_PACKS = {
    "pack1": { name: "🔰 Beginner Pack", urlPulls: "https://shiny.com/api/pack/11/recent-pulls", urlStatus: "https://shiny.com/api/jackpot/state?tier=1500&tcgType=Pokemon" },
    "pack2": { name: "⚔️ Starter Pack", urlPulls: "https://shiny.com/api/pack/3/recent-pulls", urlStatus: "https://shiny.com/api/jackpot/state?tier=2500&tcgType=Pokemon" },
    "pack3": { name: "🔥 Pro Pack", urlPulls: "https://shiny.com/api/pack/4/recent-pulls", urlStatus: "https://shiny.com/api/jackpot/state?tier=5000&tcgType=Pokemon" },
    "pack4": { name: "👑 OP Pack", urlPulls: "https://shiny.com/api/pack/12/recent-pulls", urlStatus: "https://shiny.com/api/pack/12/latest-shiny" }
};
// ==========================================

const tierMap = { 'S': 'Shiny', 'A': 'Platinum', 'B': 'Gold', 'C': 'Silver', 'D': 'Bronze', 'Shiny': 'Shiny', 'Platinum': 'Platinum', 'Gold': 'Gold', 'Silver': 'Silver', 'Bronze': 'Bronze' };
const defaultOdds = { 'Shiny': 0.005, 'Platinum': 0.062, 'Gold': 0.433, 'Silver': 0.075, 'Bronze': 0.425 };

// 🟢 เพิ่มหน่วยความจำประวัติโบนัส (bonusHistory) ให้แต่ละแพ็ค
let appState = {};
for (let id in TARGET_PACKS) {
    appState[id] = {
        lastPullId: 0,
        odds: { ...defaultOdds },
        status: { since: 0, target: 200, stage: 0, prizeName: "", prizeImg: "" },
        cards: [],
        bonusHistory: [] // เก็บประวัติโบนัสที่แตกไปแล้ว
    };
}

// 🟢 ระบบโหลดเซฟ (ดัดแปลงให้รองรับการเซฟประวัติโบนัสด้วย)
if (fs.existsSync(HISTORY_FILE)) {
    try {
        let saved = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        for(let id in saved) { 
            if(appState[id]) {
                if (Array.isArray(saved[id])) { // รองรับไฟล์เซฟเก่า
                    appState[id].cards = saved[id];
                } else { // ไฟล์เซฟเวอร์ชันใหม่
                    appState[id].cards = saved[id].cards || [];
                    appState[id].bonusHistory = saved[id].bonusHistory || [];
                }
            }
        }
    } catch (e) {}
}

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });
io.on('connection', (socket) => { sendUpdate(); });

function calculateProbs(id) {
    const history = appState[id].cards;
    const recent16 = history.slice(0, 16);
    let currentOdds = appState[id].odds;

    if (recent16.length === 0) {
        let defaultProbs = {};
        for (let t in currentOdds) { defaultProbs[t] = (currentOdds[t] * 100).toFixed(1); }
        return defaultProbs;
    }

    const counts = recent16.reduce((acc, c) => { acc[c.tier] = (acc[c.tier] || 0) + 1; return acc; }, {});
    let probs = {}; let totalW = 0;
    
    for (let t in currentOdds) {
        let currentFreq = (counts[t] || 0) / recent16.length;
        let weight = currentOdds[t] + ((currentOdds[t] - currentFreq) * 2.5); 
        probs[t] = Math.max(weight, 0.0001); 
        totalW += probs[t];
    }
    for (let t in probs) { probs[t] = ((probs[t] / totalW) * 100).toFixed(1); }
    return probs;
}

function calculateStats(id) {
    const history = appState[id].cards;
    let currentOdds = appState[id].odds;
    let stats = {};

    for (let t in currentOdds) {
        let prob = currentOdds[t];
        let average = Math.round(1 / prob); 
        let passed = 0;
        for (let i = 0; i < history.length; i++) {
            if (history[i].tier === t) break;
            passed++;
        }

        let remaining = average - passed;
        let statusMsg = "ลุ้นได้เลย"; let colorCode = "normal";
        
        if (passed >= average * 1.5) { statusMsg = "เลยกำหนดนานแล้ว"; colorCode = "danger"; remaining = 0; } 
        else if (passed >= average) { statusMsg = "จะมาเร็วๆ นี้"; colorCode = "warning"; remaining = 0; } 
        else if (passed < average * 0.4) { statusMsg = "ยังเร็วเกินไป"; colorCode = "early"; }

        stats[t] = { average, passed, remaining: remaining > 0 ? remaining : 0, status: statusMsg, colorCode };
    }
    return stats;
}

function analyzeBonus(id) {
    let since = appState[id].status.since || 0;
    let target = appState[id].status.target || 200;
    if (target === 0) target = 200; 

    let percent = (since / target) * 100;
    let target90 = Math.ceil(target * 0.90); 
    let pullsTo90 = target90 - since; 
    let pullsTo100 = target - since;  

    let statusMsg = ""; let color = "#94a3b8";

    if (percent >= 100) { statusMsg = "🔥 100% การันตีแตก! สไนป์เดี๋ยวนี้!"; color = "var(--red)"; pullsTo90 = 0; } 
    else if (percent >= 90) { statusMsg = `🎯 โซนปลอดภัย 90%+ (การันตีในอีก ${pullsTo100} ใบ)`; color = "var(--Gold)"; pullsTo90 = 0; } 
    else if (percent >= 75) { statusMsg = `⚠️ เริ่มอุ่น! ปล่อยเปิดอีก ${pullsTo90} ใบเข้าโซน 90%`; color = "var(--Platinum)"; } 
    else { statusMsg = `❄️ ยังไกล... รออีก ${pullsTo90} ใบ`; color = "#94a3b8"; }

    return { percent: Math.min(percent, 100).toFixed(1), pullsTo90: pullsTo90 > 0 ? pullsTo90 : 0, pullsTo100: pullsTo100 > 0 ? pullsTo100 : 0, status: statusMsg, color };
}

function processItem(id, item) {
    const rawTier = item.tier || item.cardTier || item.rarity || 'D';
    const tierName = tierMap[rawTier] || 'Bronze'; 
    let imgUrl = item.thumbnailUrl || item.image || "https://via.placeholder.com/100x140?text=No+Img";
    if (!imgUrl.startsWith('http')) imgUrl = BASE_URL + imgUrl;

    appState[id].cards.unshift({
        tier: tierName, img: imgUrl, price: item.worth || item.value || item.price || 0, name: item.cardName || item.name || "Unknown Card"
    });
    if (appState[id].cards.length > MAX_MEMORY) appState[id].cards.pop();
}

async function fetchData() {
    for (let id in TARGET_PACKS) {
        try {
            const pack = TARGET_PACKS[id];
            const [resStatus, resPulls] = await Promise.all([
                fetch(pack.urlStatus, { signal: AbortSignal.timeout(5000) }).catch(() => null),
                fetch(pack.urlPulls, { signal: AbortSignal.timeout(5000) }).catch(() => null)
            ]);

            if (resStatus && resStatus.ok) {
                const s = await resStatus.json();
                let bonusImg = "";
                if (s.prizeCard && s.prizeCard.thumbnailUrl) {
                    bonusImg = s.prizeCard.thumbnailUrl.startsWith('http') ? s.prizeCard.thumbnailUrl : BASE_URL + s.prizeCard.thumbnailUrl;
                }
                
                // 🟢 ระบบตรวจจับโบนัสแตก (ถ้าจำนวนใบถูกรีเซ็ตลดลงอย่างฮวบฮาบ = โบนัสแตกแล้ว!)
                let newSince = s.opensWithoutWin !== undefined ? s.opensWithoutWin : appState[id].status.since;
                let oldSince = appState[id].status.since;
                
                if (oldSince > 10 && newSince < oldSince && (oldSince - newSince > 10)) {
                    appState[id].bonusHistory.unshift({
                        time: new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }),
                        name: appState[id].status.prizeName || "Bonus",
                        img: appState[id].status.prizeImg, // เอารูปเป้าหมายก่อนหน้านี้มาโชว์
                        at: oldSince // แตกที่กี่ใบ
                    });
                    // เก็บประวัติย้อนหลัง 5 รอบล่าสุด
                    if (appState[id].bonusHistory.length > 5) appState[id].bonusHistory.pop(); 
                }
                
                if (s.odds) {
                    appState[id].odds = { 'Shiny': s.odds.S || defaultOdds.Shiny, 'Platinum': s.odds.A || defaultOdds.Platinum, 'Gold': s.odds.B || defaultOdds.Gold, 'Silver': s.odds.C || defaultOdds.Silver, 'Bronze': s.odds.D || defaultOdds.Bronze };
                }
                appState[id].status = {
                    since: newSince,
                    target: s.nextStageAt || appState[id].status.target,
                    stage: s.stage !== undefined ? s.stage : appState[id].status.stage,
                    prizeName: (s.prizeCard && s.prizeCard.name) ? s.prizeCard.name : appState[id].status.prizeName || "Target Bonus",
                    prizeImg: bonusImg || appState[id].status.prizeImg
                };
            }

            if (resPulls && resPulls.ok) {
                const pData = await resPulls.json();
                const pulls = Array.isArray(pData) ? pData : (pData.data || []);
                if (pulls.length > 0) {
                    if (appState[id].lastPullId === 0) {
                        appState[id].lastPullId = pulls[0].id;
                        pulls.slice(0, 30).reverse().forEach(i => processItem(id, i));
                    } else {
                        let news = pulls.filter(i => i.id > appState[id].lastPullId).reverse();
                        if (news.length > 0) {
                            news.forEach(i => processItem(id, i));
                            appState[id].lastPullId = pulls[0].id;
                        }
                    }
                }
            }
        } catch (e) { /* ข้ามแพ็คที่ API มีปัญหาไปก่อน */ }
    }
    
    // 🟢 บันทึกข้อมูลและประวัติโบนัสทั้งหมดลงไฟล์ (จะได้ไม่หายตอนบอทรีสตาร์ท)
    let toSave = {};
    for(let id in appState) {
        toSave[id] = { cards: appState[id].cards, bonusHistory: appState[id].bonusHistory };
    }
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(toSave));
    sendUpdate();
}

function sendUpdate() {
    let payload = { packs: TARGET_PACKS, data: {} };
    for (let id in appState) {
        const probs = calculateProbs(id); 
        const stats = calculateStats(id); 
        const bonus = analyzeBonus(id); 
        let top = "---"; let max = 0;
        if (probs) { for (let t in probs) { if (parseFloat(probs[t]) > max) { max = parseFloat(probs[t]); top = t; } } }
        
        payload.data[id] = {
            status: appState[id].status,
            cards: appState[id].cards.slice(0, 30),
            probs: probs, stats: stats, bonus: bonus, top: top,
            bonusHistory: appState[id].bonusHistory // 🟢 ส่งประวัติให้หน้าเว็บ
        };
    }
    io.emit('update_data', payload);
}

setInterval(fetchData, 3000);
fetchData();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 PokéTracker Multi-Target + History Tracker Live!`));
