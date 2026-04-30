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

let appState = {};
for (let id in TARGET_PACKS) {
    appState[id] = {
        lastPullId: 0,
        odds: { ...defaultOdds },
        status: { since: 0, target: 200, stage: 0, prizeName: "", prizeImg: "" },
        cards: [],
        bonusHistory: []
    };
}

if (fs.existsSync(HISTORY_FILE)) {
    try {
        let saved = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        for(let id in saved) { 
            if(appState[id]) {
                if (Array.isArray(saved[id])) { 
                    appState[id].cards = saved[id];
                } else { 
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
    let currentOdds = appState[id].odds;

    let probs = {}; 
    let totalW = 0;
    
    for (let t in currentOdds) {
        let prob = currentOdds[t];
        if (prob <= 0) prob = 0.0001;
        let expected = Math.round(1 / prob);
        
        let passed = 0;
        for (let i = 0; i < history.length; i++) {
            if (history[i].tier === t) break;
            passed++;
        }

        let weightMultiplier = Math.pow(1.5, (passed / expected)); 
        let weight = prob * weightMultiplier;
        
        probs[t] = Math.max(weight, 0.0001); 
        totalW += probs[t];
    }
    
    for (let t in probs) { probs[t] = ((probs[t] / totalW) * 100).toFixed(1); }
    return probs;
}

// 🟢 อัปเกรดระบบจับจำนวนใบ 97% - 99.9%
function calculateStats(id) {
    const history = appState[id].cards;
    let currentOdds = appState[id].odds;
    let stats = {};

    for (let t in currentOdds) {
        let prob = currentOdds[t];
        if (prob <= 0) prob = 0.0001;
        let expected = Math.round(1 / prob); 
        
        // 🟢 สูตรหาจำนวนใบที่การันตีโอกาสแตก 97% และ 99%
        let limit97 = Math.round(Math.log(0.03) / Math.log(1 - prob));
        let limit99 = Math.round(Math.log(0.01) / Math.log(1 - prob));

        let passed = 0;
        for (let i = 0; i < history.length; i++) {
            if (history[i].tier === t) break;
            passed++;
        }

        let statusMsg = ""; 
        let colorCode = "normal";
        let displayRemaining = 0;
        
        if (passed >= limit99) { 
            statusMsg = "💎 99% แตกชัวร์!"; 
            colorCode = "ultra"; 
            displayRemaining = 0; 
        } 
        else if (passed >= limit97) { 
            statusMsg = "🚨 การันตี 97%+"; 
            colorCode = "danger"; 
            displayRemaining = limit99 - passed; // นับถอยหลังไป 99%
        } 
        else if (passed >= expected) { 
            statusMsg = "🔥 ทะลุค่าเฉลี่ย"; 
            colorCode = "warning"; 
            displayRemaining = limit97 - passed; // นับถอยหลังไป 97%
        } 
        else { 
            statusMsg = "⏳ รอสะสมเกจ"; 
            colorCode = "early"; 
            displayRemaining = limit97 - passed; // นับถอยหลังไป 97% รวดเดียวเลย
        }

        stats[t] = { 
            average: expected, 
            passed: passed, 
            remaining: displayRemaining > 0 ? displayRemaining : 0, 
            limit97: limit97,
            limit99: limit99,
            status: statusMsg, 
            colorCode: colorCode 
        };
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
    
    const pullerName = item.username || (item.user && item.user.username) || item.playerName || item.nickname || "Anonymous";

    appState[id].cards.unshift({
        tier: tierName, 
        img: imgUrl, 
        price: item.worth || item.value || item.price || 0, 
        name: item.cardName || item.name || "Unknown Card",
        puller: pullerName
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
                
                let newSince = s.opensWithoutWin !== undefined ? s.opensWithoutWin : appState[id].status.since;
                let oldSince = appState[id].status.since;
                
                if (oldSince > 10 && newSince < oldSince && (oldSince - newSince > 10)) {
                    const thaiTime = new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
                    
                    appState[id].bonusHistory.unshift({
                        time: thaiTime, 
                        name: appState[id].status.prizeName || "Bonus",
                        img: appState[id].status.prizeImg, 
                        at: oldSince 
                    });
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
        } catch (e) { }
    }
    
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
            bonusHistory: appState[id].bonusHistory 
        };
    }
    io.emit('update_data', payload);
}

setInterval(fetchData, 3000);
fetchData();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 PokéTracker Absolute 99% Precision Live!`));
