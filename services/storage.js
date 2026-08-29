const path = require('path');
const fs = require('fs');
const { pool } = require('../utils/db');

const SESSION_ROOT = path.join(__dirname, '..', 'data', 'session');

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

async function createAccount(label) {
    const sessionFolder = `account-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    ensureDir(path.join(SESSION_ROOT, sessionFolder));

    const [result] = await pool.execute(
        'INSERT INTO unofc_accounts (label, session_folder) VALUES (?, ?)',
        [label, sessionFolder]
    );

    return getAccountById(result.insertId);
}

async function getAccounts() {
    const [rows] = await pool.query('SELECT * FROM unofc_accounts ORDER BY id ASC');
    return rows;
}

async function getAccountById(id) {
    const [rows] = await pool.execute('SELECT * FROM unofc_accounts WHERE id = ?', [id]);
    return rows[0] || null;
}

async function updateAccount(id, fields) {
    const keys = Object.keys(fields);
    if (!keys.length) return getAccountById(id);

    const setClause = keys.map(key => `${key} = ?`).join(', ');
    const values = keys.map(key => fields[key]);
    values.push(id);

    await pool.execute(`UPDATE unofc_accounts SET ${setClause} WHERE id = ?`, values);
    return getAccountById(id);
}

async function saveQr(accountId, qrString) {
    await pool.execute('UPDATE unofc_accounts SET last_qr = ?, status = ? WHERE id = ?', [qrString, 'qr', accountId]);
}

async function clearQr(accountId) {
    await pool.execute('UPDATE unofc_accounts SET last_qr = NULL WHERE id = ?', [accountId]);
}

async function upsertChat(accountId, chat) {
    const { id: whatsappId, name, isGroup } = chat;
    await pool.execute(
        `INSERT INTO unofc_chats (account_id, whatsapp_id, name, is_group)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), is_group = VALUES(is_group)`,
        [accountId, whatsappId, name || null, isGroup ? 1 : 0]
    );
}

async function updateChatLastMessage(accountId, whatsappId, body, timestamp) {
    await pool.execute(
        `UPDATE unofc_chats
         SET last_message = ?, last_message_at = ?
         WHERE account_id = ? AND whatsapp_id = ?`,
        [body, timestamp || null, accountId, whatsappId]
    );
}

async function getChats(accountId) {
    const [rows] = await pool.execute(
        `SELECT id, whatsapp_id AS whatsappId, name, is_group AS isGroup,
                last_message AS lastMessage, last_message_at AS lastMessageAt
         FROM unofc_chats
         WHERE account_id = ?
         ORDER BY COALESCE(last_message_at, 0) DESC, name ASC`,
        [accountId]
    );
    return rows;
}

async function getChatByWhatsappId(accountId, whatsappId) {
    const [rows] = await pool.execute(
        `SELECT * FROM unofc_chats WHERE account_id = ? AND whatsapp_id = ?`,
        [accountId, whatsappId]
    );
    return rows[0] || null;
}

async function saveMessage(accountId, chatRecord, payload) {
    if (payload.fromMe) {
        return null;
    }
    return saveIncomingMessage(accountId, chatRecord, payload);
}

async function saveIncomingMessage(accountId, chatRecord, payload) {
    await pool.execute(
        `INSERT INTO unofc_incoming_messages
         (account_id, chat_id, whatsapp_chat_id, message_id, sender, author_id, body,
          message_type, timestamp, media_mime, media_filename, has_media)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            sender = VALUES(sender),
            author_id = VALUES(author_id),
            body = VALUES(body),
            message_type = VALUES(message_type),
            timestamp = VALUES(timestamp),
            media_mime = VALUES(media_mime),
            media_filename = VALUES(media_filename),
            has_media = VALUES(has_media)`,
        [
            accountId,
            chatRecord ? chatRecord.id : null,
            payload.chatWhatsappId,
            payload.messageId,
            payload.sender || null,
            payload.authorId || null,
            payload.body || null,
            payload.messageType || null,
            payload.timestamp || null,
            payload.mediaMime || null,
            payload.mediaFilename || null,
            payload.mediaData || payload.mediaMime || payload.mediaFilename ? 1 : 0
        ]
    );

    const [rows] = await pool.execute(
        `SELECT id, whatsapp_chat_id AS whatsappChatId, message_id AS messageId,
                sender, author_id AS authorId, 0 AS fromMe, body,
                message_type AS messageType, timestamp, NULL AS ack,
                NULL AS ackSentAt, NULL AS ackDeliveredAt, NULL AS ackReadAt, NULL AS ackPlayedAt,
                media_mime AS mediaMime, media_filename AS mediaFilename, has_media AS hasMedia
         FROM unofc_incoming_messages
         WHERE account_id = ? AND message_id = ?`,
        [accountId, payload.messageId]
    );
    return rows[0] || null;
}

async function saveOutgoingMessage(payload) {
    const [result] = await pool.execute(
        `INSERT INTO unofc_outgoing_messages
         (account_id, target, resolved_target, whatsapp_chat_id, message_id, body, message_type,
          status, sent_at, ack, ack_sent_at, ack_delivered_at, ack_read_at, ack_played_at,
          media_url, media_mime, media_filename)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            target = VALUES(target),
            resolved_target = VALUES(resolved_target),
            whatsapp_chat_id = VALUES(whatsapp_chat_id),
            body = VALUES(body),
            message_type = VALUES(message_type),
            status = VALUES(status),
            sent_at = VALUES(sent_at),
            ack = VALUES(ack),
            ack_sent_at = COALESCE(unofc_outgoing_messages.ack_sent_at, VALUES(ack_sent_at)),
            ack_delivered_at = COALESCE(unofc_outgoing_messages.ack_delivered_at, VALUES(ack_delivered_at)),
            ack_read_at = COALESCE(unofc_outgoing_messages.ack_read_at, VALUES(ack_read_at)),
            ack_played_at = COALESCE(unofc_outgoing_messages.ack_played_at, VALUES(ack_played_at)),
            media_url = VALUES(media_url),
            media_mime = VALUES(media_mime),
            media_filename = VALUES(media_filename)`,
        [
            payload.accountId,
            payload.target,
            payload.resolvedTarget || null,
            payload.whatsappChatId || null,
            payload.messageId || null,
            payload.body || null,
            payload.messageType || null,
            payload.status || 'sent',
            payload.sentAt || Date.now(),
            payload.ack ?? null,
            payload.ackSentAt ?? null,
            payload.ackDeliveredAt ?? null,
            payload.ackReadAt ?? null,
            payload.ackPlayedAt ?? null,
            payload.mediaUrl || null,
            payload.mediaMime || null,
            payload.mediaFilename || null
        ]
    );
    return result.insertId;
}

async function getMessages(accountId, whatsappChatId, limit = 50) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    const [rows] = await pool.query(
        `SELECT *
         FROM (
            SELECT id, whatsapp_chat_id AS whatsappChatId, message_id AS messageId,
                   sender, author_id AS authorId, 0 AS fromMe, body, message_type AS messageType,
                   timestamp, NULL AS ack, NULL AS ackSentAt, NULL AS ackDeliveredAt,
                   NULL AS ackReadAt, NULL AS ackPlayedAt, media_mime AS mediaMime,
                   media_filename AS mediaFilename, has_media AS hasMedia, NULL AS mediaUrl
            FROM unofc_incoming_messages
            WHERE account_id = ? AND whatsapp_chat_id = ?
            UNION ALL
            SELECT id, whatsapp_chat_id AS whatsappChatId, message_id AS messageId,
                   'You' AS sender, NULL AS authorId, 1 AS fromMe, body, message_type AS messageType,
                   sent_at AS timestamp, ack, ack_sent_at AS ackSentAt, ack_delivered_at AS ackDeliveredAt,
                   ack_read_at AS ackReadAt, ack_played_at AS ackPlayedAt, media_mime AS mediaMime,
                   media_filename AS mediaFilename, media_url IS NOT NULL AS hasMedia, media_url AS mediaUrl
            FROM unofc_outgoing_messages
            WHERE account_id = ? AND whatsapp_chat_id = ?
         ) combined_messages
         ORDER BY timestamp DESC
         LIMIT ${safeLimit}`,
        [accountId, whatsappChatId, accountId, whatsappChatId]
    );
    return rows.reverse();
}

async function getMessageMedia(accountId, messageDbId) {
    return null;
}

async function updateMessageAck(accountId, messageId, ack) {
    return updateOutgoingMessageAck(accountId, messageId, ack);
}

async function updateOutgoingMessageAck(accountId, messageId, ack) {
    const now = Date.now();
    await pool.execute(
        `UPDATE unofc_outgoing_messages SET
            ack = ?,
            ack_sent_at = CASE WHEN ? >= 1 AND ack_sent_at IS NULL THEN ? ELSE ack_sent_at END,
            ack_delivered_at = CASE WHEN ? >= 2 AND ack_delivered_at IS NULL THEN ? ELSE ack_delivered_at END,
            ack_read_at = CASE WHEN ? >= 3 AND ack_read_at IS NULL THEN ? ELSE ack_read_at END,
            ack_played_at = CASE WHEN ? >= 4 AND ack_played_at IS NULL THEN ? ELSE ack_played_at END
         WHERE account_id = ? AND message_id = ?`,
        [ack, ack, now, ack, now, ack, now, ack, now, accountId, messageId]
    );
    return now;
}

module.exports = {
    createAccount,
    getAccounts,
    getAccountById,
    updateAccount,
    saveQr,
    clearQr,
    upsertChat,
    updateChatLastMessage,
    getChats,
    getChatByWhatsappId,
    saveMessage,
    getMessages,
    getMessageMedia,
    updateMessageAck,
    saveIncomingMessage,
    saveOutgoingMessage,
    updateOutgoingMessageAck
};
