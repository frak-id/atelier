CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `settings` (`key`, `value`, `updated_at`)
SELECT
  CASE `path`
    WHEN '/.atelier/session-templates.json' THEN 'session-templates'
    WHEN '/.atelier/system-model-config.json' THEN 'system-model-config'
    WHEN '/.atelier/cliproxy-settings.json' THEN 'cliproxy.settings'
    WHEN '/.atelier/cliproxy-opencode-providers.json' THEN 'cliproxy.providers'
    WHEN '/.atelier/cliproxy-sandbox-keys.json' THEN 'cliproxy.sandbox-keys'
  END,
  `content`,
  `updated_at`
FROM `config_files`
WHERE `scope` = 'global'
  AND `path` IN (
    '/.atelier/session-templates.json',
    '/.atelier/system-model-config.json',
    '/.atelier/cliproxy-settings.json',
    '/.atelier/cliproxy-opencode-providers.json',
    '/.atelier/cliproxy-sandbox-keys.json'
  );
--> statement-breakpoint
DELETE FROM `config_files`
WHERE `scope` = 'global'
  AND `path` IN (
    '/.atelier/session-templates.json',
    '/.atelier/system-model-config.json',
    '/.atelier/cliproxy-settings.json',
    '/.atelier/cliproxy-opencode-providers.json',
    '/.atelier/cliproxy-sandbox-keys.json'
  );
