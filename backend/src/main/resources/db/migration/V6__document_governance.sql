ALTER TABLE doc ADD COLUMN delete_batch varchar(36) DEFAULT NULL;
ALTER TABLE doc ADD COLUMN purged bit(1) NOT NULL DEFAULT b'0';
ALTER TABLE doc ADD COLUMN cleanup_complete bit(1) NOT NULL DEFAULT b'0';

CREATE TABLE doc_collaborator (
  doc_id bigint NOT NULL,
  user_id bigint NOT NULL,
  access_role varchar(16) NOT NULL,
  PRIMARY KEY (doc_id, user_id)
);

CREATE TABLE doc_share_link (
  id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  doc_id bigint NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  password_hash varchar(100),
  expires_at datetime(6) NOT NULL,
  INDEX idx_doc_share (doc_id)
);

CREATE TABLE doc_share_redemption (
  link_id bigint NOT NULL,
  user_id bigint NOT NULL,
  PRIMARY KEY (link_id, user_id),
  INDEX idx_doc_redemption_user (user_id),
  FOREIGN KEY (link_id) REFERENCES doc_share_link(id) ON DELETE CASCADE
);

CREATE TABLE doc_retired_room (
  doc_id bigint NOT NULL,
  room_key varchar(64) NOT NULL,
  PRIMARY KEY (doc_id, room_key)
);
