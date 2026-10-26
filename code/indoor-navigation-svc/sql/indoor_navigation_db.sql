CREATE DATABASE IF NOT EXISTS indoor_navigation_db
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE indoor_navigation_db;

CREATE TABLE IF NOT EXISTS login_accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(100) NOT NULL,
  password VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_login_accounts_username (username)
);

CREATE TABLE IF NOT EXISTS map_layouts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- Current live row uses map_layout.json; current sandbox row uses sandbox_map_layout.json.
  filename VARCHAR(255) NULL,
  display_name VARCHAR(255) NULL,
  layout_json LONGTEXT NOT NULL,
  layout_version INT UNSIGNED NOT NULL DEFAULT 1,
  is_sandbox TINYINT(1) NOT NULL DEFAULT 0,
  source_draft_id BIGINT UNSIGNED NULL,
  is_current TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_map_layouts_filename_is_sandbox (filename, is_sandbox),
  KEY idx_map_layouts_scope_current_updated_at (is_sandbox, is_current, updated_at),
  KEY idx_map_layouts_scope_created_at (is_sandbox, created_at),
  KEY idx_map_layouts_scope_source_draft_id (is_sandbox, source_draft_id),
  CONSTRAINT chk_map_layouts_json_valid CHECK (JSON_VALID(layout_json))
);

CREATE TABLE IF NOT EXISTS draft_map_layouts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  filename VARCHAR(255) NOT NULL,
  display_name VARCHAR(255) NULL,
  layout_json LONGTEXT NOT NULL,
  layout_version INT UNSIGNED NOT NULL DEFAULT 1,
  is_sandbox TINYINT(1) NOT NULL DEFAULT 0,
  source_map_layout_id BIGINT UNSIGNED NULL,
  is_deleted TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_draft_map_layouts_filename_is_sandbox (filename, is_sandbox),
  KEY idx_draft_map_layouts_is_sandbox_created_at (is_sandbox, created_at),
  KEY idx_draft_map_layouts_is_sandbox_deleted_created_at (is_sandbox, is_deleted, created_at),
  KEY idx_draft_map_layouts_scope_source_map_layout_id (is_sandbox, source_map_layout_id),
  CONSTRAINT chk_draft_map_layouts_json_valid CHECK (JSON_VALID(layout_json))
);

CREATE TABLE IF NOT EXISTS navigation_graph_caches (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  cache_key VARCHAR(100) NOT NULL,
  map_layout_id BIGINT UNSIGNED NULL,
  graph_json LONGTEXT NOT NULL,
  cache_version INT UNSIGNED NOT NULL,
  is_sandbox TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_navigation_graph_caches_map_layout_id (map_layout_id),
  UNIQUE KEY uq_navigation_graph_caches_cache_key_is_sandbox (cache_key, is_sandbox),
  KEY idx_navigation_graph_caches_scope_updated_at (is_sandbox, updated_at),
  CONSTRAINT chk_navigation_graph_caches_json_valid CHECK (JSON_VALID(graph_json))
);
