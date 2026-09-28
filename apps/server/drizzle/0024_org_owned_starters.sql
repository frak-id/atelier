-- Launchpad starters belong to an organization and launch in it. Move every
-- user-owned starter to its author's personal org (users without one keep
-- theirs; they stay visible to their author only).
UPDATE `launchpad_starters`
SET
  `owner_type` = 'org',
  `owner_id` = (
    SELECT `personal_org_id` FROM `users`
    WHERE `users`.`id` = `launchpad_starters`.`owner_id`
  )
WHERE `owner_type` = 'user'
  AND EXISTS (
    SELECT 1 FROM `users`
    WHERE `users`.`id` = `launchpad_starters`.`owner_id`
      AND `users`.`personal_org_id` IS NOT NULL
  );
