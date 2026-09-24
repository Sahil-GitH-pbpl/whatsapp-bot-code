
/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

CREATE DATABASE /*!32312 IF NOT EXISTS*/ `whatsapp` /*!40100 DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci */;

USE `whatsapp`;
DROP TABLE IF EXISTS `ofc_conversation_audit`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `ofc_conversation_audit` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `mobile` varchar(45) NOT NULL,
  `action_type` varchar(80) NOT NULL,
  `performed_by_name` varchar(120) NOT NULL,
  `old_owner_name` varchar(120) DEFAULT NULL,
  `new_owner_name` varchar(120) DEFAULT NULL,
  `old_value` text DEFAULT NULL,
  `new_value` text DEFAULT NULL,
  `reason` text DEFAULT NULL,
  `payload_json` longtext DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_actions_mobile_created` (`mobile`,`created_at`),
  KEY `idx_actions_type` (`action_type`)
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `ofc_conversation_live_state`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `ofc_conversation_live_state` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `mobile` varchar(45) NOT NULL,
  `owner_name` varchar(120) DEFAULT NULL,
  `conversation_type` varchar(80) DEFAULT NULL,
  `status` varchar(40) NOT NULL DEFAULT 'open',
  `closed_by_name` varchar(120) DEFAULT NULL,
  `closed_at` datetime DEFAULT NULL,
  `closure_note` text DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `sla_started_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `mobile` (`mobile`),
  KEY `idx_state_status` (`status`),
  KEY `idx_state_type` (`conversation_type`)
) ENGINE=InnoDB AUTO_INCREMENT=13 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `ofc_waba_incoming`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `ofc_waba_incoming` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `mobile` varchar(45) NOT NULL,
  `msg` text NOT NULL,
  `img` text NOT NULL,
  `pdff` varchar(225) NOT NULL,
  `docid` text NOT NULL,
  `imgid` text NOT NULL,
  `empname` varchar(225) NOT NULL,
  `datetimess` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_waba_incoming_mobile_date` (`mobile`,`datetimess`),
  KEY `idx_waba_incoming_date` (`datetimess`),
  KEY `idx_waba_incoming_mobile_id` (`mobile`,`id`)
) ENGINE=InnoDB AUTO_INCREMENT=10 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `ofc_waba_outgoing`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `ofc_waba_outgoing` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `mobile` varchar(45) NOT NULL,
  `msg` text NOT NULL,
  `img` text NOT NULL,
  `pdff` varchar(225) NOT NULL,
  `docid` text NOT NULL,
  `imgid` text NOT NULL,
  `empname` varchar(225) NOT NULL,
  `datetimess` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `provider_message_id` varchar(191) DEFAULT NULL,
  `delivery_status` varchar(80) DEFAULT NULL,
  `delivery_status_remark` text DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_waba_outgoing_mobile_date` (`mobile`,`datetimess`),
  KEY `idx_waba_outgoing_date` (`datetimess`),
  KEY `idx_waba_outgoing_provider_message_id` (`provider_message_id`),
  KEY `idx_waba_outgoing_mobile_id` (`mobile`,`id`),
  KEY `idx_waba_outgoing_mobile_empname_date` (`mobile`,`empname`,`datetimess`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `unofc_accounts`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `unofc_accounts` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `label` varchar(100) NOT NULL,
  `phone_number` varchar(32) DEFAULT NULL,
  `status` varchar(32) NOT NULL DEFAULT 'initializing',
  `last_qr` text DEFAULT NULL,
  `session_folder` varchar(255) NOT NULL,
  `skip_history_before_ready` tinyint(1) NOT NULL DEFAULT 0,
  `last_ready_at` bigint(20) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `phone_number` (`phone_number`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `unofc_center`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `unofc_center` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `center_name` varchar(255) NOT NULL,
  `groupid` varchar(64) NOT NULL,
  `assignmenttype` varchar(255) DEFAULT NULL,
  `auto_reply` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `groupid` (`groupid`)
) ENGINE=InnoDB AUTO_INCREMENT=152 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `unofc_chats`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `unofc_chats` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `account_id` int(11) NOT NULL,
  `whatsapp_id` varchar(64) NOT NULL,
  `name` varchar(255) DEFAULT NULL,
  `is_group` tinyint(1) DEFAULT 0,
  `last_message` text DEFAULT NULL,
  `last_message_at` bigint(20) DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_chat` (`account_id`,`whatsapp_id`),
  CONSTRAINT `fk_unofc_chats_account` FOREIGN KEY (`account_id`) REFERENCES `unofc_accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=288 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `unofc_group_categories`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `unofc_group_categories` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `group_id` varchar(80) NOT NULL,
  `group_name` varchar(255) NOT NULL,
  `category` enum('client','internal','vacancy','vendor') NOT NULL DEFAULT 'internal',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `group_id` (`group_id`)
) ENGINE=InnoDB AUTO_INCREMENT=2437 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `unofc_incoming_messages`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `unofc_incoming_messages` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `account_id` int(11) NOT NULL,
  `chat_id` bigint(20) DEFAULT NULL,
  `whatsapp_chat_id` varchar(64) NOT NULL,
  `message_id` varchar(128) NOT NULL,
  `sender` varchar(255) DEFAULT NULL,
  `author_id` varchar(64) DEFAULT NULL,
  `body` text DEFAULT NULL,
  `message_type` varchar(32) DEFAULT NULL,
  `timestamp` bigint(20) DEFAULT NULL,
  `media_mime` varchar(128) DEFAULT NULL,
  `media_filename` varchar(255) DEFAULT NULL,
  `has_media` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_incoming_message` (`account_id`,`message_id`),
  KEY `incoming_account_chat_idx` (`account_id`,`whatsapp_chat_id`),
  KEY `fk_unofc_incoming_messages_chat` (`chat_id`),
  CONSTRAINT `fk_unofc_incoming_messages_account` FOREIGN KEY (`account_id`) REFERENCES `unofc_accounts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_unofc_incoming_messages_chat` FOREIGN KEY (`chat_id`) REFERENCES `unofc_chats` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=154 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `unofc_outgoing_messages`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `unofc_outgoing_messages` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `account_id` int(11) NOT NULL,
  `target` varchar(128) NOT NULL,
  `resolved_target` varchar(128) DEFAULT NULL,
  `whatsapp_chat_id` varchar(64) DEFAULT NULL,
  `message_id` varchar(128) DEFAULT NULL,
  `body` text DEFAULT NULL,
  `message_type` varchar(32) DEFAULT NULL,
  `status` varchar(32) NOT NULL DEFAULT 'sent',
  `sent_at` bigint(20) NOT NULL,
  `ack` tinyint(4) DEFAULT NULL,
  `ack_sent_at` bigint(20) DEFAULT NULL,
  `ack_delivered_at` bigint(20) DEFAULT NULL,
  `ack_read_at` bigint(20) DEFAULT NULL,
  `ack_played_at` bigint(20) DEFAULT NULL,
  `media_url` text DEFAULT NULL,
  `media_mime` varchar(128) DEFAULT NULL,
  `media_filename` varchar(255) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_outgoing_message` (`account_id`,`message_id`),
  KEY `outgoing_account_target_idx` (`account_id`,`target`),
  KEY `outgoing_message_id_idx` (`message_id`),
  CONSTRAINT `fk_unofc_outgoing_messages_account` FOREIGN KEY (`account_id`) REFERENCES `unofc_accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=70 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `unofc_pickup`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `unofc_pickup` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `center` varchar(255) NOT NULL,
  `assignment_type` varchar(255) DEFAULT NULL,
  `schedule_date` varchar(64) DEFAULT NULL,
  `pickupdesc` text DEFAULT NULL,
  `pickuptype` varchar(64) DEFAULT NULL,
  `bookedby` varchar(64) DEFAULT NULL,
  `source_message_id` varchar(128) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=1911 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `whatsapp_groups`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `whatsapp_groups` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `group_id` varchar(80) NOT NULL,
  `group_name` varchar(255) NOT NULL,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_group_id` (`group_id`)
) ENGINE=InnoDB AUTO_INCREMENT=289 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `whatsapp_send_logs`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `whatsapp_send_logs` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `action_type` varchar(40) NOT NULL,
  `api_type` varchar(20) NOT NULL,
  `lab_id` varchar(60) DEFAULT NULL,
  `related_id` varchar(60) DEFAULT NULL,
  `related_code` varchar(80) DEFAULT NULL,
  `recipient` varchar(50) NOT NULL,
  `message_text` text DEFAULT NULL,
  `template_name` varchar(100) DEFAULT NULL,
  `payload_json` longtext DEFAULT NULL,
  `media_url` text DEFAULT NULL,
  `is_success` tinyint(1) NOT NULL DEFAULT 0,
  `error_text` text DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `sent_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_wa_send_logs_success` (`is_success`),
  KEY `idx_wa_send_logs_action` (`action_type`),
  KEY `idx_wa_send_logs_related` (`related_id`),
  KEY `idx_whatsapp_send_logs_lab_id` (`lab_id`)
) ENGINE=InnoDB AUTO_INCREMENT=5115 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

