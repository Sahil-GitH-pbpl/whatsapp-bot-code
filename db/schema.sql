CREATE TABLE IF NOT EXISTS accounts (
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

CREATE TABLE IF NOT EXISTS chats (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    account_id INT NOT NULL,
    whatsapp_id VARCHAR(64) NOT NULL,
    name VARCHAR(255),
    is_group TINYINT(1) DEFAULT 0,
    last_message TEXT,
    last_message_at BIGINT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_chat (account_id, whatsapp_id),
    CONSTRAINT fk_chats_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS messages (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    account_id INT NOT NULL,
    chat_id BIGINT,
    whatsapp_chat_id VARCHAR(64) NOT NULL,
    message_id VARCHAR(128) NOT NULL,
    sender VARCHAR(255),
    author_id VARCHAR(64),
    from_me TINYINT(1) DEFAULT 0,
    body TEXT,
    message_type VARCHAR(32),
    timestamp BIGINT,
    ack TINYINT,
    ack_sent_at BIGINT,
    ack_delivered_at BIGINT,
    ack_read_at BIGINT,
    ack_played_at BIGINT,
    media_mime VARCHAR(128),
    media_filename VARCHAR(255),
    media_data LONGTEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_message (account_id, message_id),
    KEY account_chat_idx (account_id, whatsapp_chat_id),
    CONSTRAINT fk_messages_chat FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE SET NULL,
    CONSTRAINT fk_messages_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stewindiawhatsapp (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    phone VARCHAR(32) NOT NULL,
    value TEXT,
    full_push_name VARCHAR(255),
    sender_whatsapp_id VARCHAR(64),
    test111 VARCHAR(64),
    dateone VARCHAR(64),
    datetimesss DATETIME,
    empname VARCHAR(64),
    status TINYINT(1) NOT NULL DEFAULT 0,
    messages_id BIGINT NULL,
    automation_message_id VARCHAR(128) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_stew_phone_time (phone, datetimesss)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pickup (
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

CREATE TABLE IF NOT EXISTS center (
    id INT AUTO_INCREMENT PRIMARY KEY,
    center_name VARCHAR(255) NOT NULL,
    groupid VARCHAR(64) NOT NULL UNIQUE,
    assignmenttype VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wabacenter (
    id INT AUTO_INCREMENT PRIMARY KEY,
    wabaid VARCHAR(32) NOT NULL,
    centerid VARCHAR(64) NOT NULL,
    UNIQUE KEY unique_waba_center (wabaid, centerid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
