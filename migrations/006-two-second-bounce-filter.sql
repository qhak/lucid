-- Exclude short single-page visits while retaining fast navigations to another page.
ALTER TABLE session_quality ADD COLUMN first_page TEXT;
ALTER TABLE session_quality ADD COLUMN second_page TEXT;

UPDATE session_quality
SET first_page=(SELECT path FROM events e WHERE e.session_id=session_quality.session_id AND e.name='pageview' AND e.path IS NOT NULL ORDER BY e.ts,e.id LIMIT 1),
    second_page=(SELECT path FROM events e WHERE e.session_id=session_quality.session_id AND e.name='pageview' AND e.path IS NOT NULL AND e.path!=(SELECT e2.path FROM events e2 WHERE e2.session_id=session_quality.session_id AND e2.name='pageview' AND e2.path IS NOT NULL ORDER BY e2.ts,e2.id LIMIT 1) ORDER BY e.ts,e.id LIMIT 1)
WHERE EXISTS (SELECT 1 FROM events e WHERE e.session_id=session_quality.session_id AND e.name='pageview' AND e.path IS NOT NULL);

-- Apply the stronger rule to stored sessions where timing and pages are available.
UPDATE session_quality
SET qualified=CASE WHEN visible_ms>=2000 OR second_page IS NOT NULL THEN 1 ELSE 0 END,
    reason=CASE WHEN reason='known_bot' THEN 'known_bot'
                WHEN visible_ms>=2000 OR second_page IS NOT NULL THEN 'confirmed'
                WHEN reason LIKE 'legacy_%' THEN reason
                ELSE 'unconfirmed' END
WHERE reason!='known_bot';
