CREATE TABLE IF NOT EXISTS unofc_accounts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    label VARCHAR(100) NOT NULL,
    phone_number VARCHAR(32) UNIQUE,
    status VARCHAR(32) NOT NULL DEFAULT 'initializing',
    last_qr TEXT,
    session_folder VARCHAR(255) NOT NULL,
    skip_history_before_ready TINYINT(1) NOT NULL DEFAULT 0,
    last_ready_at BIGINT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS unofc_chats (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    account_id INT NOT NULL,
    whatsapp_id VARCHAR(64) NOT NULL,
    name VARCHAR(255),
    is_group TINYINT(1) DEFAULT 0,
    last_message TEXT,
    last_message_at BIGINT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_chat (account_id, whatsapp_id),
    CONSTRAINT fk_unofc_chats_account FOREIGN KEY (account_id) REFERENCES unofc_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS unofc_incoming_messages (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    account_id INT NOT NULL,
    chat_id BIGINT,
    whatsapp_chat_id VARCHAR(64) NOT NULL,
    message_id VARCHAR(128) NOT NULL,
    sender VARCHAR(255),
    author_id VARCHAR(64),
    body TEXT,
    message_type VARCHAR(32),
    timestamp BIGINT,
    media_mime VARCHAR(128),
    media_filename VARCHAR(255),
    has_media TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_incoming_message (account_id, message_id),
    KEY incoming_account_chat_idx (account_id, whatsapp_chat_id),
    CONSTRAINT fk_unofc_incoming_messages_chat FOREIGN KEY (chat_id) REFERENCES unofc_chats(id) ON DELETE SET NULL,
    CONSTRAINT fk_unofc_incoming_messages_account FOREIGN KEY (account_id) REFERENCES unofc_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS unofc_outgoing_messages (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    account_id INT NOT NULL,
    target VARCHAR(128) NOT NULL,
    resolved_target VARCHAR(128),
    whatsapp_chat_id VARCHAR(64),
    message_id VARCHAR(128),
    body TEXT,
    message_type VARCHAR(32),
    status VARCHAR(32) NOT NULL DEFAULT 'sent',
    sent_at BIGINT NOT NULL,
    ack TINYINT,
    ack_sent_at BIGINT,
    ack_delivered_at BIGINT,
    ack_read_at BIGINT,
    ack_played_at BIGINT,
    media_url TEXT,
    media_mime VARCHAR(128),
    media_filename VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_outgoing_message (account_id, message_id),
    KEY outgoing_account_target_idx (account_id, target),
    KEY outgoing_message_id_idx (message_id),
    CONSTRAINT fk_unofc_outgoing_messages_account FOREIGN KEY (account_id) REFERENCES unofc_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS unofc_pickup (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    center VARCHAR(255) NOT NULL,
    assignment_type VARCHAR(255),
    schedule_date VARCHAR(64),
    pickupdesc TEXT,
    pickuptype VARCHAR(64),
    bookedby VARCHAR(64),
    source_message_id VARCHAR(128) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS unofc_center (
    id INT AUTO_INCREMENT PRIMARY KEY,
    center_name VARCHAR(255) NOT NULL,
    groupid VARCHAR(64) NOT NULL UNIQUE,
    assignmenttype VARCHAR(255),
    auto_reply TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
