const express = require('express');
const axios = require('axios');
const router = express.Router();

// --- CONFIGURATION ---
const CREDENTIALS = {
    username: "ali00sona1",
    password: "ali00sona1"
};

const BASE_URL = "http://147.135.212.197/crapi/had/viewstats";
const STATS_PAGE_URL = `${BASE_URL}/agent/SMSCDRStats`;

// ✅ TELEGRAM CONFIG — fill these in
const TELEGRAM_BOT_TOKEN = "8978930343:AAGeM87-kFAN9-b_e_JTeQjCS9s-y0j6-M4";      // e.g. "7412345678:AAFxxxxxxxx"
const TELEGRAM_CHAT_ID   = "-1003509638519";   // e.g. "-1001234567890" for group, "123456789" for user

const COMMON_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Mobile Safari/537.36",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": BASE_URL,
    "Accept-Language": "en-US,en;q=0.9,ur-PK;q=0.8,ur;q=0.7"
};

// --- GLOBAL STATE ---
let STATE = {
    lastLoginTime: 0,
    cookie: null,
    sessKey: null,
    loginPromise: null
};

// --- CACHE SYSTEM ---
let CACHE = {
    sms: {
        allData:   [],
        seenIds:   new Set(),
        lastFetch: 0,
        date:      null
    },
    numbers: { data: null, lastFetch: 0, date: null }
};
const CACHE_TTL = 16000;
const SESSION_TTL = 60 * 60 * 1000;

// --- TELEGRAM FORWARDER ---
// Tracks which SMS IDs have already been forwarded to Telegram
const forwardedIds = new Set();

async function sendToTelegram(message) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: "HTML"
        });
        console.log("📨 Sent to Telegram:", message.slice(0, 60));
    } catch (e) {
        console.error("❌ Telegram send error:", e.response?.data || e.message);
    }
}

// Called after every SMS fetch — forwards any new entries not yet sent
async function forwardNewSMSToTelegram(smsRows) {
    for (const row of smsRows) {
        const id = row[0];
        if (forwardedIds.has(id)) continue;

        forwardedIds.add(id);

        // row format (after fixSMS): [id, date, from, to, message, "$", status]
        const date    = row[1] || "";
        const from    = row[2] || "";
        const to      = row[3] || "";
        const message = row[4] || "";

        const text =
            `📩 <b>New SMS / OTP</b>\n` +
            `🕐 <b>Time:</b> ${date}\n` +
            `📞 <b>From:</b> ${from}\n` +
            `📱 <b>To:</b> ${to}\n` +
            `💬 <b>Message:</b> ${message}`;

        await sendToTelegram(text);
    }
}

// --- HELPERS ---
function getTodayDate() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function extractKey(html) {
    let match = html.match(/sesskey=([^&"']+)/);
    if (match) return match[1];
    match = html.match(/sesskey\s*[:=]\s*["']([^"']+)["']/);
    if (match) return match[1];
    return null;
}

// --- LOGIN ---
function performLogin() {
    if (STATE.loginPromise) return STATE.loginPromise;
    STATE.loginPromise = _doLogin().finally(() => { STATE.loginPromise = null; });
    return STATE.loginPromise;
}

async function _doLogin() {
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        console.log(`🔐 Login attempt ${attempt}/${MAX_RETRIES}...`);
        try {
            const instance = axios.create({ headers: COMMON_HEADERS, timeout: 15000, withCredentials: true });
            const r1 = await instance.get(`${BASE_URL}/login`);

            let tempCookie = "";
            if (r1.headers['set-cookie']) {
                const c = r1.headers['set-cookie'].find(x => x.includes('PHPSESSID'));
                if (c) tempCookie = c.split(';')[0];
            }

            const match = r1.data.match(/What is (\d+) \+ (\d+) = \?/);
            if (!match) throw new Error("Captcha not found in login page");
            const ans = parseInt(match[1]) + parseInt(match[2]);
            console.log("🔢 Captcha:", ans);

            const r2 = await instance.post(`${BASE_URL}/signin`, new URLSearchParams({
                username: CREDENTIALS.username,
                password: CREDENTIALS.password,
                capt: ans
            }), {
                headers: { "Content-Type": "application/x-www-form-urlencoded", "Cookie": tempCookie, "Referer": `${BASE_URL}/login` },
                maxRedirects: 0,
                validateStatus: () => true
            });

            if (r2.headers['set-cookie']) {
                const newC = r2.headers['set-cookie'].find(x => x.includes('PHPSESSID'));
                STATE.cookie = newC ? newC.split(';')[0] : tempCookie;
            } else {
                STATE.cookie = tempCookie;
            }

            const r3 = await axios.get(STATS_PAGE_URL, {
                headers: { ...COMMON_HEADERS, "Cookie": STATE.cookie, "Referer": `${BASE_URL}/agent/SMSDashboard` },
                timeout: 15000
            });

            if (r3.data.includes('id="loginform"')) {
                throw new Error("Login rejected — wrong credentials or captcha");
            }

            const key = extractKey(r3.data);
            if (!key) throw new Error("sessKey not found after login");

            STATE.sessKey = key;
            STATE.lastLoginTime = Date.now();
            console.log(`✅ Login complete! sessKey: ${key}`);
            return;

        } catch(e) {
            console.error(`❌ Login attempt ${attempt} failed: ${e.message}`);
            STATE.cookie = null;
            STATE.sessKey = null;
            if (attempt < MAX_RETRIES) {
                const delay = attempt * 2000;
                console.log(`⏳ Retrying in ${delay/1000}s...`);
                await new Promise(r => setTimeout(r, delay));
            } else {
                throw new Error(`Login failed after ${MAX_RETRIES} attempts: ${e.message}`);
            }
        }
    }
}

// --- FETCH WITH AUTO RELOGIN ---
async function fetchWithRelogin(urlFn, referer) {
    const MAX = 3;
    for (let attempt = 1; attempt <= MAX; attempt++) {

        const sessionAge = Date.now() - STATE.lastLoginTime;
        if (STATE.cookie && STATE.sessKey && sessionAge > SESSION_TTL) {
            console.log(`⏰ Session TTL expired (${Math.round(sessionAge/60000)} min) — force relogin...`);
            STATE.cookie = null;
            STATE.sessKey = null;
        }

        if (!STATE.cookie || !STATE.sessKey) {
            console.log(`🔁 No session (attempt ${attempt}/${MAX}) — logging in...`);
            await performLogin();
            if (!STATE.sessKey) {
                console.error(`❌ Login done but sessKey still missing (attempt ${attempt}/${MAX})`);
                if (attempt < MAX) continue;
                throw new Error("Login succeeded but sessKey not found");
            }
        }

        const url = typeof urlFn === 'function' ? urlFn() : urlFn;

        try {
            const response = await axios.get(url, {
                headers: { ...COMMON_HEADERS, "Cookie": STATE.cookie, "Referer": referer },
                timeout: 20000
            });

            const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);

            if (body.includes('Direct Script') || body.includes('id="loginform"')) {
                console.warn(`⚠️ Session expired (attempt ${attempt}/${MAX}) — forcing relogin...`);
                STATE.cookie = null;
                STATE.sessKey = null;
                if (attempt < MAX) {
                    await performLogin();
                    continue;
                }
                throw new Error("Session expired — relogin failed after max attempts");
            }

            return response.data;

        } catch(e) {
            if (e.response?.status === 403) {
                console.warn(`⚠️ 403 (attempt ${attempt}/${MAX}) — forcing relogin...`);
                STATE.cookie = null;
                STATE.sessKey = null;
                if (attempt < MAX) {
                    await performLogin();
                    continue;
                }
            }
            throw e;
        }
    }
}

// --- SMS ACCUMULATOR ---
function accumulateSMS(newRows) {
    let addedCount = 0;
    for (const row of newRows) {
        const id = row[0];
        if (!CACHE.sms.seenIds.has(id)) {
            CACHE.sms.seenIds.add(id);
            CACHE.sms.allData.push(row);
            addedCount++;
        }
    }
    if (addedCount > 0) {
        console.log(`➕ ${addedCount} new SMS(es) accumulated. Total: ${CACHE.sms.allData.length}`);
    } else {
        console.log(`📭 No new SMS — total still: ${CACHE.sms.allData.length}`);
    }
}

// --- ROUTE ---
router.get('/', async (req, res) => {
    const { type } = req.query;
    if (type !== 'sms' && type !== 'numbers')
        return res.status(400).json({ error: "Use ?type=sms or ?type=numbers" });

    const now   = Date.now();
    const today = getTodayDate();

    // ==================== NUMBERS ====================
    if (type === 'numbers') {
        if (CACHE.numbers.date && CACHE.numbers.date !== today) {
            console.log(`🔄 Date changed — numbers cache reset`);
            CACHE.numbers = { data: null, lastFetch: 0, date: null };
        }
        if (CACHE.numbers.data && (now - CACHE.numbers.lastFetch) < CACHE_TTL) {
            console.log(`📦 Cache hit [numbers] — ${Math.round((now - CACHE.numbers.lastFetch)/1000)}s ago`);
            return res.json(CACHE.numbers.data);
        }

        const referer = `${BASE_URL}/agent/MySMSNumbers`;
        try {
            const raw = await fetchWithRelogin(
                () => `${BASE_URL}/agent/res/data_smsnumbers.php?frange=&fagent=&sEcho=2&iDisplayStart=0&iDisplayLength=-1&_=${Date.now()}`,
                referer
            );
            let result = typeof raw === 'string' ? JSON.parse(raw) : raw;
            result = fixNumbers(result);
            if (result?.aaData?.length > 0)
                CACHE.numbers = { data: result, lastFetch: Date.now(), date: today };
            else if (CACHE.numbers.data)
                return res.json(CACHE.numbers.data);
            return res.json(result);
        } catch(e) {
            console.error("❌ Numbers fetch error:", e.message);
            if (CACHE.numbers.data) return res.json(CACHE.numbers.data);
            return res.status(500).json({ error: e.message });
        }
    }

    // ==================== SMS ====================
    if (CACHE.sms.date && CACHE.sms.date !== today) {
        console.log(`🌅 New day detected — SMS cache full reset`);
        CACHE.sms = { allData: [], seenIds: new Set(), lastFetch: 0, date: null };
    }

    if (CACHE.sms.date && (now - CACHE.sms.lastFetch) < CACHE_TTL) {
        console.log(`📦 Cache hit [sms] — ${Math.round((now - CACHE.sms.lastFetch)/1000)}s ago, serving ${CACHE.sms.allData.length} records`);
        return res.json(buildSMSResponse(CACHE.sms.allData));
    }

    const referer = `${BASE_URL}/agent/SMSCDRStats`;
    try {
        const raw = await fetchWithRelogin(
            () => {
                const ts = Date.now();
                return `${BASE_URL}/agent/res/data_smscdr.php?fdate1=${today}%2000:00:00&fdate2=${today}%2023:59:59&frange=&fclient=&fnum=&fcli=&fgdate=&fgmonth=&fgrange=&fgclient=&fgnumber=&fgcli=&fg=0&sesskey=${STATE.sessKey}&sEcho=1&iColumns=9&sColumns=%2C%2C%2C%2C%2C%2C%2C%2C&iDisplayStart=0&iDisplayLength=-1&mDataProp_0=0&sSearch_0=&bRegex_0=false&bSearchable_0=true&bSortable_0=true&mDataProp_1=1&sSearch_1=&bRegex_1=false&bSearchable_1=true&bSortable_1=true&mDataProp_2=2&sSearch_2=&bRegex_2=false&bSearchable_2=true&bSortable_2=true&mDataProp_3=3&sSearch_3=&bRegex_3=false&bSearchable_3=true&bSortable_3=true&mDataProp_4=4&sSearch_4=&bRegex_4=false&bSearchable_4=true&bSortable_4=true&mDataProp_5=5&sSearch_5=&bRegex_5=false&bSearchable_5=true&bSortable_5=true&mDataProp_6=6&sSearch_6=&bRegex_6=false&bSearchable_6=true&bSortable_6=true&mDataProp_7=7&sSearch_7=&bRegex_7=false&bSearchable_7=true&bSortable_7=true&mDataProp_8=8&sSearch_8=&bRegex_8=false&bSearchable_8=true&bSortable_8=false&sSearch=&bRegex=false&iSortCol_0=0&sSortDir_0=desc&iSortingCols=1&_=${ts}`;
            },
            referer
        );

        let result = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const fixed = fixSMS(result);

        if (fixed?.aaData?.length > 0) {
            accumulateSMS(fixed.aaData);

            // ✅ Forward new SMSes to Telegram (non-blocking)
            forwardNewSMSToTelegram(fixed.aaData).catch(e =>
                console.error("Telegram forward error:", e.message)
            );

            console.log(`✅ SMS fetch done. Accumulated total: ${CACHE.sms.allData.length}`);
        } else {
            console.log(`⚠️ Empty result — serving accumulated ${CACHE.sms.allData.length} records`);
        }

        CACHE.sms.lastFetch = Date.now();
        CACHE.sms.date = today;

        res.set('Content-Type', 'application/json');
        return res.json(buildSMSResponse(CACHE.sms.allData));

    } catch(e) {
        console.error("❌ SMS fetch error:", e.message, "— serving cached", CACHE.sms.allData.length, "records");
        CACHE.sms.lastFetch = Date.now();
        CACHE.sms.date = CACHE.sms.date || today;
        if (CACHE.sms.allData.length > 0)
            return res.json(buildSMSResponse(CACHE.sms.allData));
        return res.status(500).json({ error: e.message });
    }
});

// --- SMS RESPONSE BUILDER ---
function buildSMSResponse(allData) {
    return {
        sEcho: 1,
        iTotalRecords: allData.length,
        iTotalDisplayRecords: allData.length,
        aaData: allData
    };
}

// --- AUTO RELOGIN ---
async function doAutoRelogin() {
    console.log("⏰ Auto relogin triggered — fresh login...");
    STATE.cookie = null;
    STATE.sessKey = null;
    try {
        await performLogin();
        console.log("✅ Auto relogin successful");
    } catch(e) {
        console.error("❌ Auto relogin failed:", e.message);
    }
}

function scheduleNextRelogin() {
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(now.getHours() + 1, 0, 0, 0);
    const msUntilNext = nextHour - now;

    console.log(`🕐 Next auto relogin scheduled at ${nextHour.toLocaleTimeString()} (in ${Math.round(msUntilNext/1000)}s)`);

    setTimeout(async () => {
        await doAutoRelogin();
        scheduleNextRelogin();
    }, msUntilNext);
}

scheduleNextRelogin();

module.exports = router;

performLogin().catch(e => console.error("Initial login error:", e.message));

/* ================= FIX NUMBERS ================= */
function fixNumbers(data) {
    if (!data.aaData) return data;
    data.aaData = data.aaData.map(row => [
        row[1], "", row[3],
        (row[4] || "").replace(/<[^>]+>/g, "").trim(),
        (row[7] || "").replace(/<[^>]+>/g, "").trim()
    ]);
    return data;
}

/* ================= FIX SMS ================= */
function fixSMS(data) {
    if (!data.aaData) return data;
    data.aaData = data.aaData.map(row => {
        const message = (row[5] || "").replace(/kamibroken/gi, "").trim();
        if (!message) return null;
        return [row[0], row[1], row[2], row[3], message, "$", row[7] || 0];
    }).filter(Boolean);
    return data;
}
