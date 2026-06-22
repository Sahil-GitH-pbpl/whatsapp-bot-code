const http = require('http');
const https = require('https');
const { pool, legacyPool } = require('../utils/db');

function parseAccountId(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

const SEND_ACCOUNT_ID = parseAccountId(process.env.WAPP_SEND_ACCOUNT_ID, 1);
const READ_ACCOUNT_ID = parseAccountId(process.env.WAPP_READ_ACCOUNT_ID, SEND_ACCOUNT_ID);
const API_BASE_URL = (process.env.WAPP_API_BASE_URL || 'http://localhost:3004').replace(/\/$/, '');
const OVERRIDE_REPLY_TARGET = (process.env.WAPP_OVERRIDE_REPLY_TARGET || '').trim();
const IST_TZ = 'Asia/Kolkata';
const AUTO_REPLY_SIGNATURES = (process.env.WAPP_AUTOREPLY_SIGNATURES || 'thank you for your request of sample pick up|Regards CS BOT')
    .split('|')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);

const DEFAULT_EMPLOYEE_NUMBERS = [
    '919319824441',
    '917838104597',
    '918287906213',
    '918287906795',
    '919999910870',
    '919810030372',
    '919810637037',
    '919315144233',
];

const EMPLOYEE_NUMBERS = (
    process.env.WAPP_EMPLOYEE_NUMBERS || DEFAULT_EMPLOYEE_NUMBERS.join(',')
).split(',')
    .map(value => value.trim())
    .filter(Boolean);

const EMPLOYEE_AUTHOR_IDS = (
    process.env.WAPP_EMPLOYEE_AUTHOR_IDS || ''
).split(',')
    .map(value => value.trim())
    .filter(Boolean);

const EMPLOYEE_IDS = new Set([
    ...EMPLOYEE_NUMBERS,
    ...EMPLOYEE_NUMBERS.map(num => `${num}@c.us`),
    ...EMPLOYEE_NUMBERS.map(num => `${num}@g.us`),
    ...EMPLOYEE_NUMBERS.map(num => `${num} ()`),
    ...EMPLOYEE_AUTHOR_IDS,
    ...EMPLOYEE_AUTHOR_IDS.map(id => normalizeChatId(id))
]);

const WIT_AI_TOKEN = (process.env.WIT_AI_TOKEN || '').trim();
const WIT_AI_SESSION = process.env.WIT_AI_SESSION || 'prod2g';
const FAKE_WIT_MODE = (process.env.WAPP_FAKE_WIT_MODE || 'false').toLowerCase() === 'true';
const FAKE_WIT_KEYWORDS = (process.env.WAPP_FAKE_WIT_KEYWORDS || 'ok,pickup,collection,yes')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);

function normalizeChatId(chatId = '') {
    return chatId.replace(/@g\.us$/i, '').replace(/@c\.us$/i, '');
}

function formatIstParts(date, options) {
    const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: IST_TZ, ...options });
    const parts = formatter.formatToParts(date);
    return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function formatIstPretty(date) {
    const parts = formatIstParts(date, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    });
    const dayPeriod = parts.dayPeriod ? parts.dayPeriod.toUpperCase() : '';
    return `${parts.day}-${parts.month}-${parts.year} ${parts.hour}:${parts.minute} ${dayPeriod}`;
}

function formatIstSchedule(date) {
    const parts = formatIstParts(date, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function formatIstDateTime(date) {
    const parts = formatIstParts(date, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function formatIstDate(date) {
    const parts = formatIstParts(date, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });
    return `${parts.year}-${parts.month}-${parts.day}`;
}

function httpRequest(urlString, { method = 'GET', headers = {}, body = null, timeout = 10000 } = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const lib = url.protocol === 'https:' ? https : http;
        const options = {
            method,
            hostname: url.hostname,
            path: `${url.pathname}${url.search}`,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            headers: { ...headers }
        };

        if (body) {
            const payload = typeof body === 'string' ? body : JSON.stringify(body);
            options.headers['Content-Length'] = Buffer.byteLength(payload);
            body = payload;
        }

        const req = lib.request(options, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                resolve({
                    statusCode: res.statusCode || 0,
                    headers: res.headers,
                    body: buffer.toString('utf8')
                });
            });
        });

        req.on('error', reject);
        req.setTimeout(timeout, () => {
            req.destroy(new Error('Request timed out'));
        });

        if (body) {
            req.write(body);
        }
        req.end();
    });
}

class AutomationService {
    constructor() {
        this.enabled = Number.isFinite(READ_ACCOUNT_ID);
    }
    
    shouldHandle(accountId, message) {
        if (!this.enabled) return false;
        if (Number(accountId) !== READ_ACCOUNT_ID) return false;
        if (!message || message.fromMe) return false;
        if (!message.body || !message.body.trim()) return false;
        return true;
    }

    async handleInboundMessage(accountId, message) {
        if (!this.shouldHandle(accountId, message)) {
            return;
        }

        const alreadyMirrored = await this.hasInboxEntry(message.messageId);
        if (alreadyMirrored) {
            return;
        }

        const phone = normalizeChatId(message.whatsappChatId || '');
        const senderWhatsAppId = message.authorId || '';
        const senderLabel = this.buildSenderLabel(
            phone,
            message.sender || '',
            senderWhatsAppId
        );
        const body = message.body.trim();

        if (this.isAutoReplyContent(body)) {
            console.log(`[automation] skip auto-reply content for ${phone}`);
            return;
        }

        const timestamp = Number(message.timestamp) || Date.now();
        const messageDate = new Date(timestamp);
        const prettyTime = formatIstPretty(messageDate);
        const isoDate = messageDate.toISOString();

        const now = new Date();
        const nowIstStr = formatIstDateTime(now);
        const dateFloor = formatIstDate(now);

        await this.insertInboxRow({
            phone,
            value: body,
            senderName: senderLabel,
            senderWhatsAppId,
            prettyTime,
            isoDate,
            nowIstStr,
            messageDbId: message.id,
            automationMessageId: message.messageId
        });
        console.log(`[automation] inbox stored for ${phone}`);

        const senderIsEmployee = this.isEmployeeSender(senderLabel, senderWhatsAppId);
        if (senderIsEmployee) {
            console.log(`[automation] skip employee sender (${senderLabel}/${senderWhatsAppId || ''})`);
            return;
        }

        const centerRow = await this.lookupCenter(phone);
        if (!centerRow) {
            console.log(`[automation] skip, no center mapping for ${phone}`);
            return;
        }

        let witResponse = null;
        try {
            witResponse = await this.runWitAi(body);
        } catch (err) {
            console.error('[automation] Wit.ai error', err.message);
        }

        if (witResponse !== 'Ok') {
            console.log(`[automation] pickup check rejected for ${phone} (wit response: ${witResponse})`);
            return;
        }

        const centerName = centerRow.center_name;
        const assignmentType = centerRow.assignmenttype || 'Sample Pick Up';
        const slot = formatIstSchedule(now);
        await this.insertPickup(centerName, assignmentType, body, slot, message.messageId);
        await this.updatePickupStatus(phone, dateFloor);
        console.log(`[automation] pickup created for center ${centerName} (${phone})`);

        const replyTargets = await this.resolveReplyTargets(phone, message.whatsappChatId);
        if (replyTargets.length) {
            const replyText =
                "Thank you for your request of sample pick up. Your request has been generated. A rider will be assigned shortly.\nRegards CS BOT";
            for (const target of replyTargets) {
                try {
                    await this.sendWhatsappMessage(target, replyText);
                    console.log(`[automation] reply sent to ${target}`);
                } catch (err) {
                    console.error('[automation] failed to send reply', err.message);
                }
            }
        }
    }

    async hasInboxEntry(messageId) {
        const [rows] = await pool.execute(
            'SELECT id FROM stewindiawhatsapp WHERE automation_message_id = ? LIMIT 1',
            [messageId]
        );
        return rows.length > 0;
    }

    async insertInboxRow(payload) {
        await pool.execute(
            `INSERT INTO stewindiawhatsapp
                (phone, value, full_push_name, sender_whatsapp_id, test111, dateone, datetimesss, empname, messages_id, automation_message_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'Client', ?, ?)`,
            [
                payload.phone,
                payload.value,
                payload.senderName,
                payload.senderWhatsAppId || null,
                payload.prettyTime,
                payload.isoDate,
                payload.nowIstStr,
                payload.messageDbId || null,
                payload.automationMessageId || null,
            ]
        );
    }

    async insertPickup(centerName, assignmentType, description, slot, sourceMessageId) {
        await pool.execute(
            `INSERT INTO pickup (center, assignment_type, schedule_date, pickupdesc, pickuptype, bookedby, source_message_id)
             VALUES (?, ?, ?, ?, 'WJS', 'Online', ?)`,
            [centerName, assignmentType, slot, description, sourceMessageId]
        );
        if (legacyPool) {
            try {
                await legacyPool.execute(
                    `INSERT INTO pickup (center, assignment_type, schedule_date, pickupdesc, pickuptype, bookedby)
                     VALUES (?, ?, ?, ?, 'WJS', 'Online')`,
                    [centerName, assignmentType, slot, description]
                );
                console.log('[automation] legacy pickup mirrored');
            } catch (err) {
                console.error('[automation] legacy pickup insert failed', err.message);
            }
        }
    }

    async updatePickupStatus(phone, dateFloor) {
        await pool.execute(
            'UPDATE stewindiawhatsapp SET status = 1 WHERE phone = ? AND datetimesss >= ?',
            [phone, `${dateFloor} 00:00:00`]
        );
    }

    async lookupCenter(groupId) {
        const [rows] = await pool.execute(
            'SELECT center_name, assignmenttype FROM center WHERE groupid = ? LIMIT 1',
            [groupId]
        );
        return rows[0];
    }

    isEmployeeSender(displayName, waId) {
        const normalizedId = normalizeChatId(waId || '');
        return EMPLOYEE_IDS.has(waId) || EMPLOYEE_IDS.has(normalizedId) || EMPLOYEE_IDS.has(displayName);
    }

    async runWitAi(message) {
        if (FAKE_WIT_MODE) {
            const normalized = message.toLowerCase();
            return FAKE_WIT_KEYWORDS.some(keyword => normalized.includes(keyword)) ? 'Ok' : null;
        }
        if (!WIT_AI_TOKEN) {
            return null;
        }
        const response = await httpRequest(
            `https://api.wit.ai/event?v=20240304&session_id=${encodeURIComponent(WIT_AI_SESSION)}&context_map=%7B%7D`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${WIT_AI_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: {
                    type: 'message',
                    message
                },
                timeout: Number(process.env.WAPP_WIT_TIMEOUT || 5) * 1000
            }
        );

        if (response.statusCode < 200 || response.statusCode >= 300) {
            throw new Error(`Wit.ai HTTP ${response.statusCode}: ${response.body}`);
        }

        try {
            const parsed = JSON.parse(response.body);
            return parsed?.response?.text || null;
        } catch (err) {
            throw new Error(`Failed to parse Wit.ai response: ${err.message}`);
        }
    }

    async resolveReplyTargets(centerId, defaultChatId) {
        if (!SEND_ACCOUNT_ID) return [];
        const shouldReply = await this.hasWabaCenter(centerId);
        if (!shouldReply) return [];

        const targets = [];
        if (defaultChatId) {
            targets.push(defaultChatId);
        }
        if (OVERRIDE_REPLY_TARGET) {
            const normalized = /^\d+$/.test(OVERRIDE_REPLY_TARGET)
                ? `${OVERRIDE_REPLY_TARGET}@c.us`
                : OVERRIDE_REPLY_TARGET;
            targets.push(normalized);
        }
        return [...new Set(targets.filter(Boolean))];
    }

    async hasWabaCenter(centerId) {
        const [rows] = await pool.execute(
            'SELECT centerid FROM wabacenter WHERE wabaid = ? AND centerid = ? LIMIT 1',
            ['1', centerId]
        );
        return rows.length > 0;
    }

    async sendWhatsappMessage(target, message) {
        const payload = { target, message };
        const response = await httpRequest(`${API_BASE_URL}/api/accounts/${SEND_ACCOUNT_ID}/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            timeout: 10000
        });
        if (response.statusCode < 200 || response.statusCode >= 300) {
            throw new Error(`Send API HTTP ${response.statusCode}: ${response.body}`);
        }
    }

    isAutoReplyContent(body) {
        if (!AUTO_REPLY_SIGNATURES.length || !body) return false;
        const normalized = body.toLowerCase();
        return AUTO_REPLY_SIGNATURES.some(signature => normalized.includes(signature));
    }

    buildSenderLabel(phone, rawName, waId) {
        let display = rawName && rawName.trim() && rawName.trim().toLowerCase() !== 'contact'
            ? rawName.trim()
            : null;
        if (!display && waId) {
            display = normalizeChatId(waId);
        }
        if (!display) {
            display = phone || 'Contact';
        }
        return `${phone} (${display})`;
    }
}

module.exports = AutomationService;
