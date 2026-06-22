const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const DB_CONFIG = {
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'whatsapp_control',
    waitForConnections: true,
    connectionLimit: 10,
    namedPlaceholders: true
};

const pool = mysql.createPool(DB_CONFIG);

const legacyConfig = {
    host: process.env.WA_HOST,
    user: process.env.WA_USER,
    password: process.env.WA_PASSWORD,
    database: process.env.WA_NAME,
    waitForConnections: true,
    connectionLimit: 5,
    namedPlaceholders: true
};

const legacyPool = legacyConfig.host
    ? mysql.createPool(legacyConfig)
    : null;

async function waitForConnection(retries = 20, delayMs = 3000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const conn = await pool.getConnection();
            conn.release();
            return;
        } catch (err) {
            if (attempt === retries) throw err;
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
}

async function initDatabase() {
    await waitForConnection();
    const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf-8');
    const statements = sql
        .split(/;\s*(?:\r?\n|$)/)
        .map(stmt => stmt.trim())
        .filter(Boolean);

    for (const statement of statements) {
        await pool.query(statement);
    }

    // Ensure newer columns exist when upgrading without recreating the table.
    const [msgColumns] = await pool.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'messages'`
    );
    const msgNames = new Set(msgColumns.map(c => c.COLUMN_NAME));
    const msgAlters = [];
    if (!msgNames.has('author_id')) msgAlters.push('ADD COLUMN author_id VARCHAR(64) NULL AFTER sender');
    if (!msgNames.has('ack')) msgAlters.push('ADD COLUMN ack TINYINT NULL AFTER timestamp');
    if (!msgNames.has('ack_sent_at')) msgAlters.push('ADD COLUMN ack_sent_at BIGINT NULL AFTER ack');
    if (!msgNames.has('ack_delivered_at')) msgAlters.push('ADD COLUMN ack_delivered_at BIGINT NULL AFTER ack_sent_at');
    if (!msgNames.has('ack_read_at')) msgAlters.push('ADD COLUMN ack_read_at BIGINT NULL AFTER ack_delivered_at');
    if (!msgNames.has('ack_played_at')) msgAlters.push('ADD COLUMN ack_played_at BIGINT NULL AFTER ack_read_at');
    if (msgAlters.length) {
        await pool.query(`ALTER TABLE messages ${msgAlters.join(', ')}`);
    }

    const [acctColumns] = await pool.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'accounts'`
    );
    const acctNames = new Set(acctColumns.map(c => c.COLUMN_NAME));
    const acctAlters = [];
    if (!acctNames.has('skip_history_before_ready')) acctAlters.push('ADD COLUMN skip_history_before_ready TINYINT(1) NOT NULL DEFAULT 0 AFTER session_folder');
    if (!acctNames.has('last_ready_at')) acctAlters.push('ADD COLUMN last_ready_at BIGINT NULL AFTER skip_history_before_ready');
    if (acctAlters.length) {
        await pool.query(`ALTER TABLE accounts ${acctAlters.join(', ')}`);
    }

    const [legacyColumns] = await pool.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stewindiawhatsapp'`
    );
    const legacyNames = new Set(legacyColumns.map(c => c.COLUMN_NAME));
    if (!legacyNames.has('sender_whatsapp_id')) {
        await pool.query(
            'ALTER TABLE stewindiawhatsapp ADD COLUMN sender_whatsapp_id VARCHAR(64) NULL AFTER full_push_name'
        );
    }
}

module.exports = {
    pool,
    legacyPool,
    initDatabase
};
